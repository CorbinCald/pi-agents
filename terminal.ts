import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import type { SupervisorClient } from "./client.ts";

const execFileAsync = promisify(execFile);
const RESIZE_REDRAW_POLL_MS = 20;
const RESIZE_REDRAW_TIMEOUT_MS = 1_000;

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasBottomEditorBorder(
	output: string,
	columns: number,
	rows: number,
): boolean {
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
		const { stdout } = await execFileAsync(
			"tmux",
			["-L", server, "capture-pane", "-p", "-t", session],
			{ env: environment },
		);
		if (hasBottomEditorBorder(stdout, columns, rows)) return;
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
		[
			"-L",
			server,
			"display-message",
			"-p",
			"-t",
			session,
			"#{pane_width} #{pane_height}",
		],
		{ env: environment },
	);
	if (stdout.trim() === `${targetColumns} ${targetRows}`) return;

	await execFileAsync(
		"tmux",
		[
			"-L",
			server,
			"resize-window",
			"-t",
			session,
			"-x",
			String(targetColumns),
			"-y",
			String(targetRows),
		],
		{ env: environment },
	);
	// Keep the host workspace visible until Pi has redrawn its editor at the
	// target width and bottom row. Attaching earlier exposes tmux's stale pane
	// for a frame, with the editor at its former dimensions.
	await waitForResizeRedraw(
		server,
		session,
		targetColumns,
		targetRows,
		environment,
	);
	await execFileAsync(
		"tmux",
		["-L", server, "set-option", "-w", "-t", session, "window-size", "latest"],
		{ env: environment },
	);
}

/** Hand the real terminal to a persistent native Pi TUI, then restore the host. */
export async function attachAgentTerminal(
	tui: TUI,
	client: SupervisorClient,
	jobId: string,
): Promise<void> {
	const job = await client.prepareAttach(jobId);
	if (!job.terminalServer || !job.terminalSession) {
		throw new Error("Agent terminal is unavailable");
	}
	const terminalServer = job.terminalServer;
	const terminalSession = job.terminalSession;

	const {
		TMUX: _outerTmux,
		TMUX_PANE: _outerPane,
		...environment
	} = process.env;
	// The private server has no prefix by design, so expose its pane history
	// directly through conventional mouse-wheel scrolling.
	await execFileAsync(
		"tmux",
		["-L", terminalServer, "set-option", "-g", "mouse", "on"],
		{ env: environment },
	);
	await execFileAsync(
		"tmux",
		["-L", terminalServer, "set-option", "-g", "history-limit", "100000"],
		{ env: environment },
	);
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
	await matchTerminalSize(
		terminalServer,
		terminalSession,
		tui.terminal.columns,
		tui.terminal.rows,
		environment,
	);
	await tui.terminal.drainInput(100);
	tui.stop();
	tui.terminal.clearScreen();
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				"tmux",
				["-L", terminalServer, "attach-session", "-t", terminalSession],
				{
					stdio: "inherit",
					env: environment,
				},
			);
			child.once("error", reject);
			// Detaching and exiting the managed Pi process can produce different
			// tmux status codes; both normally mean control should return to Pi.
			child.once("close", () => resolve());
		});
	} finally {
		tui.terminal.clearScreen();
		tui.start();
		tui.requestRender(true);
	}
}
