import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import type { SupervisorClient } from "./client.ts";
import type { TerminalAttachmentResult } from "./types.ts";

const execFileAsync = promisify(execFile);
const RESIZE_REDRAW_POLL_MS = 20;
const RESIZE_REDRAW_TIMEOUT_MS = 1_000;
// A dedicated tmux client status distinguishes "exit host Pi" from detaching.
const ATTACHED_EXIT_CODE = 79;
const CTRL_SHIFT_C_SEQUENCE = "\u001b[99;6u";
const PRINTABLE_TMUX_KEYS = [
	"Space",
	...Array.from({ length: 94 }, (_, index) => String.fromCharCode(index + 33)).map((key) =>
		key === ";" ? "\\;" : key,
	),
];

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasBottomEditorBorder(output: string, columns: number, rows: number): boolean {
	const lines = output.replaceAll("\r", "").split("\n");
	const bottom = lines.slice(Math.max(0, lines.length - rows));
	const borderStart = Math.max(0, bottom.length - 6);
	return bottom.slice(borderStart).some((line) => {
		const characters = [...line];
		return (
			characters.length === columns &&
			["─", "━", "═", "-"].includes(characters[0] || "") &&
			characters.every((character) => character === characters[0])
		);
	});
}

async function waitForResizeRedraw(
	server: string,
	session: string,
	columns: number,
	rows: number,
	environment: NodeJS.ProcessEnv,
): Promise<void> {
	const deadline = Date.now() + RESIZE_REDRAW_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await delay(RESIZE_REDRAW_POLL_MS);
		const { stdout } = await execFileAsync("tmux", ["-L", server, "capture-pane", "-p", "-t", session], {
			env: environment,
		});
		if (hasBottomEditorBorder(stdout, columns, rows)) return;
	}
}

async function commandExists(command: string, environment: NodeJS.ProcessEnv): Promise<boolean> {
	try {
		await execFileAsync("sh", ["-c", `command -v ${command}`], {
			env: environment,
		});
		return true;
	} catch {
		return false;
	}
}

async function clipboardCopyCommand(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
	if (environment.SSH_CONNECTION || environment.SSH_CLIENT || environment.MOSH_CONNECTION) {
		return undefined;
	}

	const candidates: Array<readonly [string, string]> = [];
	if (environment.TERMUX_VERSION) {
		candidates.push(["termux-clipboard-set", "termux-clipboard-set"]);
	} else if (process.platform === "darwin") {
		candidates.push(["pbcopy", "pbcopy"]);
	} else if (environment.WSL_DISTRO_NAME) {
		candidates.push(["clip.exe", "clip.exe"]);
	} else {
		if (environment.WAYLAND_DISPLAY) {
			candidates.push(["wl-copy", "wl-copy"]);
		}
		if (environment.DISPLAY) {
			candidates.push(["xclip", "xclip -selection clipboard"], ["xsel", "xsel --clipboard --input"]);
		}
	}

	for (const [executable, command] of candidates) {
		if (await commandExists(executable, environment)) return command;
	}
	return undefined;
}

async function configureClipboard(server: string, environment: NodeJS.ProcessEnv): Promise<void> {
	await execFileAsync("tmux", ["-L", server, "set-option", "-s", "set-clipboard", "external"], { env: environment });
	const command = await clipboardCopyCommand(environment);
	await execFileAsync(
		"tmux",
		command
			? ["-L", server, "set-option", "-s", "copy-command", command]
			: ["-L", server, "set-option", "-s", "-u", "copy-command"],
		{ env: environment },
	);
}

async function configureCopyMode(server: string, environment: NodeJS.ProcessEnv): Promise<void> {
	const bindKey = (...args: string[]) =>
		execFileAsync("tmux", ["-L", server, "bind-key", ...args], {
			env: environment,
		});
	const bindTypingKeys = (table: string) => {
		const commands: string[] = [];
		for (const key of [...PRINTABLE_TMUX_KEYS, "Any"]) {
			if (commands.length > 0) commands.push(";");
			commands.push("bind-key", "-T", table, key, "send-keys", "-X", "cancel", "\\;", "send-keys");
		}
		return execFileAsync("tmux", ["-L", server, ...commands], {
			env: environment,
		});
	};
	const clickSelections = [
		["DoubleClick1Pane", "select-word"],
		["TripleClick1Pane", "select-line"],
	] as const;

	for (const table of ["copy-mode", "copy-mode-vi"]) {
		await bindKey("-T", table, "MouseUp1Pane", "send-keys", "-X", "cancel");
		await bindKey("-T", table, "MouseDragEnd1Pane", "send-keys", "-X", "copy-pipe-no-clear");
		for (const [key, selection] of clickSelections) {
			await bindKey(
				"-T",
				table,
				key,
				"select-pane",
				"\\;",
				"send-keys",
				"-X",
				selection,
				"\\;",
				"run-shell",
				"-d",
				"0.3",
				"\\;",
				"send-keys",
				"-X",
				"copy-pipe-no-clear",
			);
		}
		await bindKey("-T", table, "Escape", "send-keys", "-X", "cancel");
		await bindTypingKeys(table);
	}

	for (const [key, selection] of clickSelections) {
		await bindKey(
			"-T",
			"root",
			key,
			"select-pane",
			"-t",
			"=",
			"\\;",
			"if-shell",
			"-F",
			"#{||:#{pane_in_mode},#{mouse_any_flag}}",
			"send-keys -M",
			`copy-mode -H ; send-keys -X ${selection} ; run-shell -d 0.3 ; send-keys -X copy-pipe-no-clear`,
		);
	}
}

async function configureSinglePressExit(server: string, environment: NodeJS.ProcessEnv): Promise<void> {
	// Replacing only the attached client avoids signaling or stopping the
	// persistent worker. The host observes its status and shuts itself down.
	for (const table of ["root", "copy-mode", "copy-mode-vi"]) {
		await execFileAsync(
			"tmux",
			["-L", server, "bind-key", "-T", table, "C-c", "detach-client", "-E", `exit ${ATTACHED_EXIT_CODE}`],
			{ env: environment },
		);
	}
	// tmux falls back from C-S-c to a C-c binding unless the shifted key has
	// its own binding. Preserve it as a distinct key in live view and retain
	// its conventional clipboard behavior while a copy-mode selection exists.
	await execFileAsync(
		"tmux",
		["-L", server, "bind-key", "-T", "root", "C-S-c", "send-keys", "-l", CTRL_SHIFT_C_SEQUENCE],
		{ env: environment },
	);
	for (const table of ["copy-mode", "copy-mode-vi"]) {
		await execFileAsync(
			"tmux",
			["-L", server, "bind-key", "-T", table, "C-S-c", "send-keys", "-X", "copy-pipe-no-clear"],
			{ env: environment },
		);
	}
}

async function matchTerminalSize(
	server: string,
	session: string,
	columns: number,
	rows: number,
	environment: NodeJS.ProcessEnv,
): Promise<void> {
	const targetColumns = Math.max(1, Math.floor(columns));
	const targetRows = Math.max(1, Math.floor(rows));
	const { stdout } = await execFileAsync(
		"tmux",
		["-L", server, "display-message", "-p", "-t", session, "#{pane_width} #{pane_height}"],
		{ env: environment },
	);
	if (stdout.trim() === `${targetColumns} ${targetRows}`) return;

	await execFileAsync(
		"tmux",
		["-L", server, "resize-window", "-t", session, "-x", String(targetColumns), "-y", String(targetRows)],
		{ env: environment },
	);
	// Keep the host workspace visible until Pi has redrawn its editor at the
	// target width and bottom row. Attaching earlier exposes tmux's stale pane
	// for a frame, with the editor at its former dimensions.
	await waitForResizeRedraw(server, session, targetColumns, targetRows, environment);
	await execFileAsync("tmux", ["-L", server, "set-option", "-w", "-t", session, "window-size", "latest"], {
		env: environment,
	});
}

/** Hand the real terminal to a persistent native Pi TUI, then restore the host. */
export async function attachAgentTerminal(
	tui: TUI,
	client: SupervisorClient,
	jobId: string,
): Promise<TerminalAttachmentResult> {
	const job = await client.prepareAttach(jobId);
	if (!job.terminalServer || !job.terminalSession) {
		throw new Error("Agent terminal is unavailable");
	}
	const terminalServer = job.terminalServer;
	const terminalSession = job.terminalSession;

	const { TMUX: _outerTmux, TMUX_PANE: _outerPane, ...environment } = process.env;
	// The private server has no prefix by design, so expose its pane history
	// directly through conventional mouse-wheel scrolling.
	await execFileAsync("tmux", ["-L", terminalServer, "set-option", "-g", "mouse", "on"], { env: environment });
	await execFileAsync("tmux", ["-L", terminalServer, "set-option", "-g", "history-limit", "100000"], {
		env: environment,
	});
	await execFileAsync(
		"tmux",
		[
			"-L",
			terminalServer,
			"bind-key",
			"-T",
			"root",
			"WheelUpPane",
			"if-shell",
			"-F",
			"#{||:#{pane_in_mode},#{mouse_any_flag}}",
			"send-keys -M",
			"copy-mode -e ; send-keys -X -N 5 scroll-up",
		],
		{ env: environment },
	);
	await configureClipboard(terminalServer, environment);
	await configureCopyMode(terminalServer, environment);
	await configureSinglePressExit(terminalServer, environment);
	await matchTerminalSize(terminalServer, terminalSession, tui.terminal.columns, tui.terminal.rows, environment);
	await tui.terminal.drainInput(100);
	tui.stop();
	tui.terminal.clearScreen();
	let result: TerminalAttachmentResult | undefined;
	try {
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			const child = spawn("tmux", ["-L", terminalServer, "attach-session", "-t", terminalSession], {
				stdio: "inherit",
				env: environment,
			});
			child.once("error", reject);
			child.once("close", (code) => resolve(code));
		});
		result = exitCode === ATTACHED_EXIT_CODE ? "exit" : "detached";
		return result;
	} finally {
		tui.terminal.clearScreen();
		if (result !== "exit") {
			tui.start();
			tui.requestRender(true);
		}
	}
}
