import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import type { SupervisorClient } from "./client.ts";

const execFileAsync = promisify(execFile);

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
