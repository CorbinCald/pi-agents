import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachAgentTerminal } from "../terminal.ts";

test("attach pre-sizes and settles a hidden worker before exposing it", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agents-terminal-"));
	const tmuxPath = join(directory, "tmux");
	const logPath = join(directory, "tmux.log");
	await writeFile(
		tmuxPath,
		`#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_TEST_LOG"
case "$*" in
  *display-message*) printf '120 40\\n' ;;
  *capture-pane*)
    i=0
    while [ "$i" -lt 46 ]; do printf '\\n'; i=$((i + 1)); done
    printf '%160s\\n' '' | tr ' ' '-'
    printf '\\n\\n'
    ;;
esac
`,
	);
	await chmod(tmuxPath, 0o755);

	const originalPath = process.env.PATH;
	const originalLog = process.env.TMUX_TEST_LOG;
	process.env.PATH = `${directory}:${originalPath || ""}`;
	process.env.TMUX_TEST_LOG = logPath;

	const events = [];
	const tui = {
		terminal: {
			columns: 160,
			rows: 50,
			drainInput: async (milliseconds) => events.push(`drain:${milliseconds}`),
			clearScreen: () => events.push("clear"),
		},
		stop: () => events.push("stop"),
		start: () => events.push("start"),
		requestRender: (force) => events.push(`render:${force}`),
	};
	const client = {
		prepareAttach: async () => ({
			terminalServer: "test-server",
			terminalSession: "test-session",
		}),
	};

	try {
		const startedAt = Date.now();
		await attachAgentTerminal(tui, client, "test-job");
		assert.ok(Date.now() - startedAt >= 15);

		const commands = (await readFile(logPath, "utf8")).trim().split("\n");
		const resizeIndex = commands.indexOf(
			"-L test-server resize-window -t test-session -x 160 -y 50",
		);
		const redrawIndex = commands.indexOf(
			"-L test-server capture-pane -p -t test-session",
		);
		const automaticSizeIndex = commands.indexOf(
			"-L test-server set-option -w -t test-session window-size latest",
		);
		const attachIndex = commands.indexOf(
			"-L test-server attach-session -t test-session",
		);
		assert.ok(resizeIndex >= 0);
		assert.ok(redrawIndex > resizeIndex);
		assert.ok(automaticSizeIndex > redrawIndex);
		assert.ok(attachIndex > automaticSizeIndex);
		assert.deepEqual(events, [
			"drain:100",
			"stop",
			"clear",
			"clear",
			"start",
			"render:true",
		]);
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalLog === undefined) delete process.env.TMUX_TEST_LOG;
		else process.env.TMUX_TEST_LOG = originalLog;
		await rm(directory, { recursive: true, force: true });
	}
});
