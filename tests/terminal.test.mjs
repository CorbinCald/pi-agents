import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachAgentTerminal } from "../terminal.ts";

function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("attach configures clipboard copy and settles a resized hidden worker", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agents-terminal-"));
	const tmuxPath = join(directory, "tmux");
	const xselPath = join(directory, "xsel");
	const logPath = join(directory, "tmux.log");
	await writeFile(
		tmuxPath,
		`#!/bin/sh
printf '%s\\n' "$*" >> "$TMUX_TEST_LOG"
case "$*" in
  *display-message*) printf '120 40\\n' ;;
  *attach-session*) exit "\${TMUX_TEST_ATTACH_EXIT:-0}" ;;
  *capture-pane*)
    i=0
    while [ "$i" -lt 46 ]; do printf '\\n'; i=$((i + 1)); done
    printf '%160s\\n' '' | tr ' ' '-'
    printf '\\n\\n'
    ;;
esac
`,
	);
	await writeFile(xselPath, "#!/bin/sh\ncat >/dev/null\n");
	await Promise.all([chmod(tmuxPath, 0o755), chmod(xselPath, 0o755)]);

	const environmentKeys = [
		"PATH",
		"TMUX_TEST_LOG",
		"TMUX_TEST_ATTACH_EXIT",
		"DISPLAY",
		"WAYLAND_DISPLAY",
		"SSH_CONNECTION",
		"SSH_CLIENT",
		"MOSH_CONNECTION",
		"WSL_DISTRO_NAME",
		"TERMUX_VERSION",
	];
	const originalEnvironment = new Map(
		environmentKeys.map((key) => [key, process.env[key]]),
	);
	process.env.PATH = `${directory}:${process.env.PATH || ""}`;
	process.env.TMUX_TEST_LOG = logPath;
	process.env.DISPLAY = ":99";
	for (const key of environmentKeys.slice(1)) {
		if (key !== "TMUX_TEST_LOG" && key !== "DISPLAY") delete process.env[key];
	}

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
		const result = await attachAgentTerminal(tui, client, "test-job");
		assert.equal(result, "detached");
		assert.ok(Date.now() - startedAt >= 15);

		const commands = (await readFile(logPath, "utf8")).trim().split("\n");
		const externalClipboardIndex = commands.indexOf(
			"-L test-server set-option -s set-clipboard external",
		);
		const copyCommandIndex = commands.indexOf(
			process.platform === "darwin"
				? "-L test-server set-option -s copy-command pbcopy"
				: "-L test-server set-option -s copy-command xsel --clipboard --input",
		);
		const retainedMouseBindings = commands
			.map((command, index) => ({ command, index }))
			.filter(
				({ command }) =>
					!command.includes("C-S-c") && command.includes("copy-pipe-no-clear"),
			);
		const mouseCancelBindings = commands.filter((command) =>
			command.includes("MouseUp1Pane send-keys -X cancel"),
		);
		const typingBindings = commands.filter(
			(command) =>
				command.includes("Space send-keys -X cancel \\; send-keys") &&
				command.includes("q send-keys -X cancel \\; send-keys") &&
				command.includes("Any send-keys -X cancel \\; send-keys"),
		);
		const exitBindings = commands
			.map((command, index) => ({ command, index }))
			.filter(({ command }) =>
				command.includes("C-c detach-client -E exit 79"),
			);
		const shiftedControlCBindings = commands
			.map((command, index) => ({ command, index }))
			.filter(({ command }) => command.includes("C-S-c"));
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
		assert.ok(externalClipboardIndex >= 0);
		assert.ok(copyCommandIndex > externalClipboardIndex);
		assert.equal(retainedMouseBindings.length, 8);
		assert.equal(mouseCancelBindings.length, 2);
		assert.equal(typingBindings.length, 2);
		assert.equal(exitBindings.length, 3);
		assert.deepEqual(
			exitBindings.map(({ command }) => command.split(" ")[4]),
			["root", "copy-mode", "copy-mode-vi"],
		);
		assert.equal(shiftedControlCBindings.length, 3);
		assert.ok(
			shiftedControlCBindings.some(({ command }) =>
				command.includes("root C-S-c send-keys -l \u001b[99;6u"),
			),
		);
		assert.equal(
			shiftedControlCBindings.filter(({ command }) =>
				command.includes("C-S-c send-keys -X copy-pipe-no-clear"),
			).length,
			2,
		);
		assert.ok(exitBindings.every(({ index }) => index < resizeIndex));
		assert.ok(
			shiftedControlCBindings.every(({ index }) => index < resizeIndex),
		);
		assert.ok(
			retainedMouseBindings.every(
				({ index }) => index > copyCommandIndex && index < resizeIndex,
			),
		);
		assert.ok(resizeIndex > copyCommandIndex);
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

		events.length = 0;
		process.env.TMUX_TEST_ATTACH_EXIT = "79";
		assert.equal(await attachAgentTerminal(tui, client, "test-job"), "exit");
		assert.deepEqual(events, ["drain:100", "stop", "clear", "clear"]);
	} finally {
		for (const [key, value] of originalEnvironment) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(directory, { recursive: true, force: true });
	}
});

test("selection copies in place, then clicking or typing returns to input", {
	timeout: 5_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agents-mouse-copy-"));
	const outputPath = join(directory, "copied.txt");
	const inputPath = join(directory, "input.txt");
	const sinkPath = join(directory, "clipboard-sink.sh");
	const suffix = `${process.pid}-${Date.now()}`;
	const privateServer = `pi-agents-mouse-private-${suffix}`;
	const outerServer = `pi-agents-mouse-outer-${suffix}`;
	await writeFile(sinkPath, `#!/bin/sh\ncat > '${outputPath}'\n`);
	await chmod(sinkPath, 0o755);

	try {
		execFileSync("tmux", [
			"-L",
			privateServer,
			"-f",
			"/dev/null",
			"new-session",
			"-d",
			"-s",
			"worker",
			"-x",
			"40",
			"-y",
			"10",
			`for i in $(seq 1 30); do printf 'line-%02d-abcdefghijklmnopqrst\\n' "$i"; done; stty raw -echo; dd bs=1 count=1 of='${inputPath}' 2>/dev/null; exec sleep 5`,
		]);
		execFileSync("tmux", [
			"-L",
			privateServer,
			"set-option",
			"-g",
			"status",
			"off",
		]);
		execFileSync("tmux", [
			"-L",
			privateServer,
			"set-option",
			"-g",
			"mouse",
			"on",
		]);
		execFileSync("tmux", [
			"-L",
			privateServer,
			"set-option",
			"-s",
			"copy-command",
			sinkPath,
		]);
		for (const table of ["copy-mode", "copy-mode-vi"]) {
			for (const [key, command] of [
				["MouseUp1Pane", "cancel"],
				["MouseDragEnd1Pane", "copy-pipe-no-clear"],
			]) {
				execFileSync("tmux", [
					"-L",
					privateServer,
					"bind-key",
					"-T",
					table,
					key,
					"send-keys",
					"-X",
					command,
				]);
			}
			for (const key of ["q", "Any"]) {
				execFileSync("tmux", [
					"-L",
					privateServer,
					"bind-key",
					"-T",
					table,
					key,
					"send-keys",
					"-X",
					"cancel",
					"\\;",
					"send-keys",
				]);
			}
		}
		execFileSync("tmux", [
			"-L",
			outerServer,
			"-f",
			"/dev/null",
			"new-session",
			"-d",
			"-s",
			"host",
			"-x",
			"40",
			"-y",
			"10",
			`env -u TMUX -u TMUX_PANE TERM=xterm-256color tmux -L ${privateServer} attach-session -t worker`,
		]);
		execFileSync("tmux", [
			"-L",
			outerServer,
			"set-option",
			"-g",
			"status",
			"off",
		]);

		for (let attempt = 0; attempt < 50; attempt++) {
			const clients = execFileSync(
				"tmux",
				["-L", privateServer, "list-clients", "-F", "#{client_name}"],
				{ encoding: "utf8" },
			).trim();
			if (clients) break;
			await sleep(20);
		}

		const modeState = () =>
			execFileSync(
				"tmux",
				[
					"-L",
					privateServer,
					"display-message",
					"-p",
					"-t",
					"worker",
					"#{pane_in_mode}:#{scroll_position}:#{selection_present}",
				],
				{ encoding: "utf8" },
			).trim();
		const enterScrollback = () => {
			execFileSync("tmux", ["-L", privateServer, "copy-mode", "-t", "worker"]);
			execFileSync("tmux", [
				"-L",
				privateServer,
				"send-keys",
				"-t",
				"worker",
				"-X",
				"-N",
				"5",
				"scroll-up",
			]);
		};
		const sendMouse = (sequence) =>
			execFileSync("tmux", [
				"-L",
				outerServer,
				"send-keys",
				"-t",
				"host",
				"-l",
				sequence,
			]);
		const dragSelection = () =>
			sendMouse("\u001b[<0;1;1M\u001b[<32;10;1M\u001b[<0;10;1m");

		enterScrollback();
		const scrollPosition = Number(modeState().split(":")[1]);
		assert.ok(scrollPosition > 0);
		dragSelection();

		let copied = "";
		for (let attempt = 0; attempt < 80; attempt++) {
			try {
				copied = await readFile(outputPath, "utf8");
			} catch {
				// The asynchronous copy command has not created its output yet.
			}
			if (copied) break;
			await sleep(25);
		}
		assert.match(copied, /^line-\d{2}-a/);
		assert.equal(modeState(), `1:${scrollPosition}:1`);

		// A plain click near the bottom clears selection and returns to the app.
		sendMouse("\u001b[<0;20;9M\u001b[<0;20;9m");
		for (let attempt = 0; attempt < 20 && modeState() !== "0::"; attempt++) {
			await sleep(10);
		}
		assert.equal(modeState(), "0::");

		// A printable key also exits copy mode and is delivered to the app.
		enterScrollback();
		dragSelection();
		for (
			let attempt = 0;
			attempt < 20 && !modeState().endsWith(":1");
			attempt++
		) {
			await sleep(10);
		}
		execFileSync("tmux", [
			"-L",
			outerServer,
			"send-keys",
			"-t",
			"host",
			"-l",
			"q",
		]);
		let input = "";
		for (let attempt = 0; attempt < 40; attempt++) {
			try {
				input = await readFile(inputPath, "utf8");
			} catch {
				// The pane has not received the forwarded key yet.
			}
			if (input) break;
			await sleep(25);
		}
		assert.equal(input, "q");
		assert.equal(modeState(), "0::");
	} finally {
		for (const server of [outerServer, privateServer]) {
			try {
				execFileSync("tmux", ["-L", server, "kill-server"], {
					stdio: "ignore",
				});
			} catch {
				// A server may exit when its final attached command exits.
			}
		}
		await rm(directory, { recursive: true, force: true });
	}
});

test("only plain Ctrl+C requests host exit from live view or copy mode", {
	timeout: 5_000,
}, async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agents-ctrl-c-"));
	const suffix = `${process.pid}-${Date.now()}`;
	const privateServer = `pi-agents-exit-private-${suffix}`;
	const outerServer = `pi-agents-exit-outer-${suffix}`;

	try {
		execFileSync("tmux", [
			"-L",
			privateServer,
			"-f",
			"/dev/null",
			"new-session",
			"-d",
			"-s",
			"worker",
			"-x",
			"40",
			"-y",
			"10",
			"exec sleep 30",
		]);
		for (const table of ["root", "copy-mode", "copy-mode-vi"]) {
			execFileSync("tmux", [
				"-L",
				privateServer,
				"bind-key",
				"-T",
				table,
				"C-c",
				"detach-client",
				"-E",
				"exit 79",
			]);
		}
		execFileSync("tmux", [
			"-L",
			privateServer,
			"bind-key",
			"-T",
			"root",
			"C-S-c",
			"send-keys",
			"-l",
			"\u001b[99;6u",
		]);
		for (const table of ["copy-mode", "copy-mode-vi"]) {
			execFileSync("tmux", [
				"-L",
				privateServer,
				"bind-key",
				"-T",
				table,
				"C-S-c",
				"send-keys",
				"-X",
				"copy-pipe-no-clear",
			]);
		}

		const attachHost = async (markerPath) => {
			execFileSync("tmux", [
				"-L",
				outerServer,
				"-f",
				"/dev/null",
				"new-session",
				"-d",
				"-s",
				"host",
				"-x",
				"40",
				"-y",
				"10",
				`env -u TMUX -u TMUX_PANE TERM=xterm-256color tmux -L ${privateServer} attach-session -t worker; printf '%s' "$?" > "${markerPath}"; exec sleep 5`,
			]);
			for (let attempt = 0; attempt < 50; attempt++) {
				const clients = execFileSync(
					"tmux",
					["-L", privateServer, "list-clients", "-F", "#{client_name}"],
					{ encoding: "utf8" },
				).trim();
				if (clients) return;
				await sleep(20);
			}
			assert.fail("private tmux client did not attach");
		};

		for (const mode of ["live", "copy-mode"]) {
			const markerPath = join(directory, mode);
			await attachHost(markerPath);
			if (mode === "copy-mode") {
				execFileSync("tmux", [
					"-L",
					privateServer,
					"copy-mode",
					"-t",
					"worker",
				]);
			}

			// CSI-u preserves Shift, so Ctrl+Shift+C must not match the C-c exit
			// binding in either the root or copy-mode table.
			execFileSync("tmux", [
				"-L",
				outerServer,
				"send-keys",
				"-t",
				"host",
				"-l",
				"\u001b[99;6u",
			]);
			await sleep(50);
			await assert.rejects(readFile(markerPath, "utf8"), { code: "ENOENT" });
			assert.notEqual(
				execFileSync(
					"tmux",
					["-L", privateServer, "list-clients", "-F", "#{client_name}"],
					{ encoding: "utf8" },
				).trim(),
				"",
			);

			execFileSync("tmux", [
				"-L",
				outerServer,
				"send-keys",
				"-t",
				"host",
				"C-c",
			]);
			let marker = "";
			for (let attempt = 0; attempt < 50; attempt++) {
				try {
					marker = await readFile(markerPath, "utf8");
				} catch {
					// The attached tmux client has not returned its exit request yet.
				}
				if (marker === "79") break;
				await sleep(20);
			}

			assert.equal(marker, "79");
			assert.equal(
				execFileSync(
					"tmux",
					["-L", privateServer, "list-clients", "-F", "#{client_name}"],
					{ encoding: "utf8" },
				).trim(),
				"",
			);
			execFileSync("tmux", [
				"-L",
				privateServer,
				"has-session",
				"-t",
				"worker",
			]);
			execFileSync("tmux", ["-L", outerServer, "kill-server"]);
		}
	} finally {
		for (const server of [outerServer, privateServer]) {
			try {
				execFileSync("tmux", ["-L", server, "kill-server"], {
					stdio: "ignore",
				});
			} catch {
				// The server may already be gone.
			}
		}
		await rm(directory, { recursive: true, force: true });
	}
});
