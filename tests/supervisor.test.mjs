import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const supervisorPath = join(here, "..", "supervisor.mjs");
const fakePiPath = join(here, "fake-pi.mjs");

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await predicate();
		if (last) return last;
		await sleep(50);
	}
	throw new Error(
		`Condition not met within ${timeoutMs}ms; last value: ${JSON.stringify(last)}`,
	);
}

class TestClient {
	constructor(socket) {
		this.socket = socket;
		this.nextId = 1;
		this.pending = new Map();
		this.decoder = new StringDecoder("utf8");
		this.buffer = "";
		socket.on("data", (chunk) => this.read(chunk));
	}

	read(chunk) {
		this.buffer += this.decoder.write(chunk);
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) break;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (!line) continue;
			const message = JSON.parse(line);
			if (message.type !== "response") continue;
			const pending = this.pending.get(message.id);
			if (!pending) continue;
			this.pending.delete(message.id);
			if (message.success) pending.resolve(message.data);
			else pending.reject(new Error(message.error));
		}
	}

	request(type, payload = {}) {
		const id = `t-${this.nextId++}`;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.socket.write(`${JSON.stringify({ id, type, ...payload })}\n`);
		});
	}

	close() {
		this.socket.destroy();
	}
}

function connect(socketPath) {
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		socket.once("connect", () => resolve(new TestClient(socket)));
		socket.once("error", reject);
	});
}

function tmuxSessionExists(terminalServer, terminalSession) {
	try {
		execFileSync(
			"tmux",
			["-L", terminalServer, "has-session", "-t", terminalSession],
			{ stdio: "ignore" },
		);
		return true;
	} catch {
		return false;
	}
}

function attachedTmuxClients(terminalServer, terminalSession) {
	try {
		return execFileSync(
			"tmux",
			[
				"-L",
				terminalServer,
				"list-clients",
				"-t",
				terminalSession,
				"-F",
				"#{client_name}",
			],
			{ encoding: "utf8" },
		)
			.split("\n")
			.filter(Boolean).length;
	} catch {
		return 0;
	}
}

function sendNativeInput(terminalServer, terminalSession, text) {
	const buffer = `pi-agents-test-${process.pid}-${Date.now()}`;
	execFileSync(
		"tmux",
		["-L", terminalServer, "load-buffer", "-b", buffer, "-"],
		{ input: text },
	);
	execFileSync("tmux", [
		"-L",
		terminalServer,
		"paste-buffer",
		"-d",
		"-b",
		buffer,
		"-t",
		terminalSession,
	]);
	execFileSync("tmux", [
		"-L",
		terminalServer,
		"send-keys",
		"-t",
		terminalSession,
		"Enter",
	]);
}

async function stopProcess(child) {
	child.kill("SIGTERM");
	await Promise.race([
		new Promise((resolve) => child.once("close", resolve)),
		sleep(3_000),
	]);
}

test("supervisor persists and validates agent color labels", {
	timeout: 10_000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agents-color-test-"));
	const agentsRoot = join(root, "agents");
	const jobId = "colorjob";
	const jobDir = join(agentsRoot, "jobs", jobId);
	mkdirSync(jobDir, { recursive: true });
	writeFileSync(
		join(jobDir, "state.json"),
		`${JSON.stringify(
			{
				id: jobId,
				name: "Color labels",
				prompt: "Test color labels",
				originalCwd: root,
				cwd: root,
				model: { provider: "fake", id: "fake" },
				thinkingLevel: "medium",
				status: "complete",
				summary: "Complete",
				createdAt: Date.now(),
				updatedAt: Date.now(),
				completedAt: Date.now(),
				pinned: false,
				order: 1,
				userRenamed: false,
				isRunning: false,
				isStreaming: false,
				isolated: false,
			},
			null,
			2,
		)}\n`,
	);

	const startSupervisor = () =>
		spawn(process.execPath, [supervisorPath], {
			env: { ...process.env, PI_AGENTS_ROOT: agentsRoot },
			stdio: ["ignore", "pipe", "pipe"],
		});
	const socketPath = join(agentsRoot, "supervisor.sock");
	let supervisor = startSupervisor();
	let client;

	try {
		await waitFor(() => existsSync(socketPath));
		client = await connect(socketPath);
		const initial = await client.request("list");
		assert.equal(initial[0].labelColor, undefined);

		const colored = await client.request("set_color", {
			jobId,
			color: "purple",
		});
		assert.equal(colored.labelColor, "purple");
		assert.equal(
			JSON.parse(readFileSync(join(jobDir, "state.json"), "utf8")).labelColor,
			"purple",
		);
		await assert.rejects(
			client.request("set_color", { jobId, color: "ultraviolet" }),
			/invalid agent color/i,
		);

		client.close();
		client = undefined;
		await stopProcess(supervisor);
		supervisor = startSupervisor();
		await waitFor(() => existsSync(socketPath));
		client = await connect(socketPath);
		const restored = await client.request("list");
		assert.equal(restored[0].labelColor, "purple");

		const cleared = await client.request("set_color", {
			jobId,
			color: null,
		});
		assert.equal(cleared.labelColor, undefined);
		assert.equal(
			Object.hasOwn(
				JSON.parse(readFileSync(join(jobDir, "state.json"), "utf8")),
				"labelColor",
			),
			false,
		);
	} finally {
		client?.close();
		await stopProcess(supervisor);
		rmSync(root, { recursive: true, force: true });
	}
});

test("idle cleanup never stops a pending or attached terminal", {
	timeout: 10_000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agents-attached-idle-test-"));
	const agentsRoot = join(root, "agents");
	const jobId = "attachedidle";
	const jobDir = join(agentsRoot, "jobs", jobId);
	mkdirSync(jobDir, { recursive: true });
	writeFileSync(
		join(jobDir, "state.json"),
		`${JSON.stringify(
			{
				id: jobId,
				name: "Attached idle worker",
				prompt: "Previously completed task",
				originalCwd: root,
				cwd: root,
				model: { provider: "fake", id: "fake" },
				thinkingLevel: "medium",
				status: "complete",
				summary: "Complete",
				createdAt: Date.now() - 10_000,
				updatedAt: Date.now() - 10_000,
				completedAt: Date.now() - 10_000,
				pinned: false,
				order: 1,
				userRenamed: false,
				isRunning: false,
				isStreaming: false,
				isolated: false,
				projectTrusted: true,
			},
			null,
			2,
		)}\n`,
	);

	const supervisor = spawn(process.execPath, [supervisorPath], {
		env: {
			...process.env,
			PI_AGENTS_ROOT: agentsRoot,
			PI_AGENTS_PI_INVOCATION: JSON.stringify({
				command: process.execPath,
				argsPrefix: [fakePiPath],
			}),
			PI_AGENTS_TEST_IDLE_WORKER_TTL_MS: "50",
			PI_AGENTS_TEST_IDLE_WORKER_POLL_MS: "20",
			PI_AGENTS_TEST_ATTACH_RESERVATION_MS: "250",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let supervisorError = "";
	supervisor.stderr.on(
		"data",
		(chunk) => (supervisorError += chunk.toString()),
	);
	const socketPath = join(agentsRoot, "supervisor.sock");
	let client;
	let terminalServer;
	let terminalSession;
	const outerServer = `pi-agents-idle-host-${process.pid}-${Date.now()}`;

	try {
		await waitFor(() => existsSync(socketPath));
		client = await connect(socketPath);
		const prepared = await client.request("prepare_attach", { jobId });
		terminalServer = prepared.terminalServer;
		terminalSession = prepared.terminalSession;

		// The expired worker must survive cleanup while the caller prepares the
		// terminal handoff but has not created its tmux client yet.
		await sleep(120);
		assert.equal(tmuxSessionExists(terminalServer, terminalSession), true);

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
			"100",
			"-y",
			"30",
			`env -u TMUX -u TMUX_PANE tmux -L ${terminalServer} attach-session -t ${terminalSession}`,
		]);
		await waitFor(
			() => attachedTmuxClients(terminalServer, terminalSession) === 1,
		);

		// Let the attach reservation expire and several cleanup ticks run. The
		// real attached client must independently keep the worker alive.
		await sleep(350);
		assert.equal(tmuxSessionExists(terminalServer, terminalSession), true);
		assert.equal(attachedTmuxClients(terminalServer, terminalSession), 1);

		execFileSync("tmux", ["-L", outerServer, "kill-server"]);
		await waitFor(
			() => !tmuxSessionExists(terminalServer, terminalSession),
			3_000,
		);
		const jobs = await client.request("list");
		assert.equal(jobs[0].isRunning, false);
	} finally {
		client?.close();
		for (const server of [outerServer, terminalServer]) {
			if (!server) continue;
			try {
				execFileSync("tmux", ["-L", server, "kill-server"], {
					stdio: "ignore",
				});
			} catch {
				// A server exits when its final session is removed.
			}
		}
		await stopProcess(supervisor);
		rmSync(root, { recursive: true, force: true });
	}

	assert.equal(supervisorError, "");
});

test("supervisor launches supported GPT-5.6 workers with max Pro reasoning", {
	timeout: 15_000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agents-max-pro-test-"));
	const workspace = join(root, "workspace");
	const agentsRoot = join(root, "agents");
	mkdirSync(workspace);

	const supervisor = spawn(process.execPath, [supervisorPath], {
		env: {
			...process.env,
			PI_AGENTS_ROOT: agentsRoot,
			PI_AGENTS_PI_INVOCATION: JSON.stringify({
				command: process.execPath,
				argsPrefix: [fakePiPath],
			}),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let supervisorError = "";
	supervisor.stderr.on(
		"data",
		(chunk) => (supervisorError += chunk.toString()),
	);

	const socketPath = join(agentsRoot, "supervisor.sock");
	await waitFor(() => existsSync(socketPath));
	const client = await connect(socketPath);
	let terminalServer;

	try {
		assert.equal((await client.request("ping")).protocolVersion, 3);
		await assert.rejects(
			client.request("dispatch", {
				prompt: "reject unsupported Pro mode",
				cwd: workspace,
				model: { provider: "openai-codex", id: "gpt-5.6-sol" },
				thinkingLevel: "max",
				reasoningMode: "pro",
				projectTrusted: true,
			}),
			/direct OpenAI GPT-5\.6/i,
		);

		const dispatched = await client.request("dispatch", {
			prompt: "verify max Pro launch",
			cwd: workspace,
			model: { provider: "openai", id: "gpt-5.6-sol" },
			thinkingLevel: "max",
			reasoningMode: "pro",
			projectTrusted: true,
		});
		terminalServer = dispatched.terminalServer;
		assert.equal(dispatched.thinkingLevel, "max");
		assert.equal(dispatched.reasoningMode, "pro");

		const launchPath = join(workspace, `launch-${dispatched.id}.json`);
		await waitFor(() => existsSync(launchPath));
		const launch = JSON.parse(readFileSync(launchPath, "utf8"));
		assert.equal(launch.reasoningMode, "pro");
		assert.deepEqual(
			launch.args.slice(
				launch.args.indexOf("--thinking"),
				launch.args.indexOf("--thinking") + 2,
			),
			["--thinking", "max"],
		);

		const workerPid = Number(
			execFileSync(
				"tmux",
				[
					"-L",
					dispatched.terminalServer,
					"display-message",
					"-p",
					"-t",
					dispatched.terminalSession,
					"#{pane_pid}",
				],
				{ encoding: "utf8" },
			).trim(),
		);
		const standard = await client.request("worker_event", {
			jobId: dispatched.id,
			workerPid,
			eventType: "reasoning_mode_select",
			data: { mode: null },
		});
		assert.equal(standard.reasoningMode, undefined);
		const maxPro = await client.request("worker_event", {
			jobId: dispatched.id,
			workerPid,
			eventType: "reasoning_mode_select",
			data: { mode: "pro" },
		});
		assert.equal(maxPro.reasoningMode, "pro");

		const persisted = JSON.parse(
			readFileSync(
				join(agentsRoot, "jobs", dispatched.id, "state.json"),
				"utf8",
			),
		);
		assert.equal(persisted.reasoningMode, "pro");
		await client.request("remove", { jobId: dispatched.id });
	} finally {
		client.close();
		if (terminalServer) {
			try {
				execFileSync("tmux", ["-L", terminalServer, "kill-server"], {
					stdio: "ignore",
				});
			} catch {
				// Removing the final native session normally stops the private server.
			}
		}
		await stopProcess(supervisor);
		rmSync(root, { recursive: true, force: true });
	}

	assert.equal(supervisorError, "");
});

test("supervisor runs concurrent isolated sessions, recaps them, and cleans up worktrees", {
	timeout: 30_000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agents-test-"));
	const repo = join(root, "repo");
	const agentsRoot = join(root, "agents");
	mkdirSync(repo);
	writeFileSync(join(repo, "README.md"), "test\n");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "agents-test@example.test"], {
		cwd: repo,
	});
	execFileSync("git", ["config", "user.name", "Agents Test"], { cwd: repo });
	execFileSync("git", ["add", "README.md"], { cwd: repo });
	execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });

	const supervisor = spawn(process.execPath, [supervisorPath], {
		env: {
			...process.env,
			PI_AGENTS_ROOT: agentsRoot,
			PI_AGENTS_PI_INVOCATION: JSON.stringify({
				command: process.execPath,
				argsPrefix: [fakePiPath],
			}),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let supervisorError = "";
	supervisor.stderr.on(
		"data",
		(chunk) => (supervisorError += chunk.toString()),
	);

	const socketPath = join(agentsRoot, "supervisor.sock");
	await waitFor(() => existsSync(socketPath));
	let client = await connect(socketPath);
	let terminalServer;

	try {
		const model = { provider: "fake", id: "fake" };
		const [first, second, third] = await Promise.all([
			client.request("dispatch", {
				prompt: "finish alpha task",
				cwd: repo,
				model,
				thinkingLevel: "medium",
				projectTrusted: true,
			}),
			client.request("dispatch", {
				prompt: "ask beta task",
				cwd: repo,
				model,
				thinkingLevel: "medium",
				projectTrusted: true,
			}),
			client.request("dispatch", {
				prompt: "error gamma task",
				cwd: repo,
				model,
				thinkingLevel: "medium",
				projectTrusted: true,
			}),
		]);

		terminalServer = first.terminalServer;
		assert.equal(first.backend, "terminal");
		assert.equal(first.labelColor, undefined);
		assert.equal(second.backend, "terminal");
		assert.equal(third.backend, "terminal");
		assert.equal(first.isolated, true);
		assert.equal(second.isolated, true);
		assert.equal(third.isolated, true);
		assert.notEqual(first.worktreePath, second.worktreePath);
		assert.notEqual(second.worktreePath, third.worktreePath);
		assert.notEqual(first.branch, second.branch);

		// Closing the UI/client must not stop any background worker.
		client.close();
		client = await connect(socketPath);

		assert.equal(existsSync(join(repo, `agent-${first.id}.txt`)), false);
		assert.equal(existsSync(join(repo, `agent-${second.id}.txt`)), false);

		const settled = await waitFor(async () => {
			const records = await client.request("list");
			const alpha = records.find((job) => job.id === first.id);
			const beta = records.find((job) => job.id === second.id);
			const gamma = records.find((job) => job.id === third.id);
			return alpha?.status === "complete" &&
				alpha?.recap &&
				beta?.status === "needs_input" &&
				gamma?.status === "complete" &&
				gamma?.recap
				? { alpha, beta, gamma }
				: undefined;
		}, 12_000);

		assert.equal(
			existsSync(join(settled.alpha.worktreePath, `agent-${first.id}.txt`)),
			true,
		);
		assert.equal(
			existsSync(join(settled.beta.worktreePath, `agent-${second.id}.txt`)),
			true,
		);
		assert.match(settled.alpha.recap, /isolated worktree/i);
		assert.equal(settled.beta.waitingFor, "Which option should I use?");
		assert.equal(settled.gamma.failed, true);
		assert.equal(settled.gamma.status, "complete");
		assert.match(settled.gamma.recap, /Synthetic worker failure/);

		const alphaEntries = readFileSync(settled.alpha.sessionFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		assert.equal(
			alphaEntries.filter(
				(entry) =>
					entry.type === "message" && entry.message?.role === "assistant",
			).length,
			1,
		);

		sendNativeInput(second.terminalServer, second.terminalSession, "blue");
		const answered = await waitFor(async () => {
			const records = await client.request("list");
			const beta = records.find((job) => job.id === second.id);
			return beta?.status === "complete" && beta?.recap ? beta : undefined;
		}, 12_000);
		assert.match(answered.recap, /completed/i);

		const removedWorktree = settled.alpha.worktreePath;
		const removedBranch = settled.alpha.branch;
		await client.request("remove", { jobId: first.id });
		assert.equal(existsSync(removedWorktree), false);
		const branches = execFileSync("git", ["branch", "--list", removedBranch], {
			cwd: repo,
			encoding: "utf8",
		});
		assert.equal(branches.trim(), "");
		const remaining = await client.request("list");
		assert.equal(
			remaining.some((job) => job.id === first.id),
			false,
		);
		assert.equal(
			remaining.some((job) => job.id === second.id),
			true,
		);
		await client.request("remove", { jobId: second.id });
		await client.request("remove", { jobId: third.id });
	} finally {
		client.close();
		if (terminalServer) {
			try {
				execFileSync("tmux", ["-L", terminalServer, "kill-server"], {
					stdio: "ignore",
				});
			} catch {
				// Removing the final native session normally stops the private server.
			}
		}
		supervisor.kill("SIGTERM");
		await Promise.race([
			new Promise((resolve) => supervisor.once("close", resolve)),
			sleep(3_000),
		]);
		rmSync(root, { recursive: true, force: true });
	}

	assert.equal(supervisorError, "");
});

test("native Pi session persists across clients, attaches directly, and accepts terminal input", {
	timeout: 30_000,
}, async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agents-terminal-test-"));
	const repo = join(root, "repo");
	const agentsRoot = join(root, "agents");
	mkdirSync(repo);
	writeFileSync(join(repo, "README.md"), "test\n");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "agents-test@example.test"], {
		cwd: repo,
	});
	execFileSync("git", ["config", "user.name", "Agents Test"], {
		cwd: repo,
	});
	execFileSync("git", ["add", "README.md"], { cwd: repo });
	execFileSync("git", ["commit", "-qm", "initial"], { cwd: repo });

	const supervisor = spawn(process.execPath, [supervisorPath], {
		env: {
			...process.env,
			PI_AGENTS_ROOT: agentsRoot,
			PI_AGENTS_PI_INVOCATION: JSON.stringify({
				command: process.execPath,
				argsPrefix: [fakePiPath],
			}),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let supervisorError = "";
	supervisor.stderr.on(
		"data",
		(chunk) => (supervisorError += chunk.toString()),
	);

	const socketPath = join(agentsRoot, "supervisor.sock");
	await waitFor(() => existsSync(socketPath));
	let client = await connect(socketPath);
	let terminalServer;

	try {
		const dispatched = await client.request("dispatch", {
			prompt: "finish terminal task",
			cwd: repo,
			model: { provider: "fake", id: "fake" },
			thinkingLevel: "medium",
			projectTrusted: true,
		});
		assert.equal(dispatched.backend, "terminal");
		assert.equal(dispatched.isolated, true);
		terminalServer = dispatched.terminalServer;

		const completed = await waitFor(async () => {
			const records = await client.request("list");
			const job = records.find((record) => record.id === dispatched.id);
			return job?.status === "complete" && job.recap ? job : undefined;
		}, 12_000);
		assert.equal(completed.isRunning, true);
		assert.ok(completed.sessionFile);
		execFileSync(
			"tmux",
			["-L", terminalServer, "set-option", "-g", "mouse", "off"],
			{ stdio: "ignore" },
		);
		const prepared = await client.request("prepare_attach", {
			jobId: dispatched.id,
		});
		assert.equal(prepared.sessionFile, completed.sessionFile);
		assert.equal(prepared.terminalSession, dispatched.terminalSession);
		assert.equal(
			execFileSync(
				"tmux",
				[
					"-L",
					terminalServer,
					"display-message",
					"-p",
					"-t",
					dispatched.terminalSession,
					"#{pane_current_path}",
				],
				{ encoding: "utf8" },
			).trim(),
			completed.cwd,
		);
		assert.equal(
			execFileSync(
				"tmux",
				["-L", terminalServer, "show-options", "-gv", "mouse"],
				{ encoding: "utf8" },
			).trim(),
			"on",
		);
		assert.equal(
			execFileSync(
				"tmux",
				["-L", terminalServer, "show-options", "-gv", "history-limit"],
				{ encoding: "utf8" },
			).trim(),
			"100000",
		);
		assert.match(
			execFileSync("tmux", ["-L", terminalServer, "list-keys", "-T", "root"], {
				encoding: "utf8",
			}),
			/WheelUpPane.*copy-mode -e.*scroll-up/,
		);
		assert.equal(
			existsSync(join(completed.worktreePath, `agent-${dispatched.id}.txt`)),
			true,
		);

		client.close();
		client = await connect(socketPath);
		const reconnected = await client.request("list");
		assert.equal(reconnected[0].isRunning, true);

		const managedWorkerPid = Number(
			execFileSync(
				"tmux",
				[
					"-L",
					dispatched.terminalServer,
					"display-message",
					"-p",
					"-t",
					dispatched.terminalSession,
					"#{pane_pid}",
				],
				{ encoding: "utf8" },
			).trim(),
		);

		// A nested Pi inherits PI_AGENT_JOB_ID, but it does not own the managed
		// tmux pane and must not be able to stop the parent job.
		await client.request("worker_event", {
			jobId: dispatched.id,
			workerPid: managedWorkerPid,
			eventType: "agent_start",
		});
		await assert.rejects(
			client.request("worker_event", {
				jobId: dispatched.id,
				workerPid: process.pid,
				eventType: "session_shutdown",
				data: { reason: "quit" },
			}),
			/not the managed Pi process/,
		);
		const records = await client.request("list");
		assert.equal(
			records.find((job) => job.id === dispatched.id).status,
			"working",
		);

		// If a valid but stale shutdown event is ever applied, definitive tool
		// activity must still restore the working state.
		const falselyStopped = await client.request("worker_event", {
			jobId: dispatched.id,
			workerPid: managedWorkerPid,
			eventType: "session_shutdown",
			data: { reason: "quit" },
		});
		assert.equal(falselyStopped.status, "complete");
		assert.equal(falselyStopped.stopped, true);
		const recovered = await client.request("worker_event", {
			jobId: dispatched.id,
			workerPid: managedWorkerPid,
			eventType: "tool_execution_start",
			data: { toolName: "bash", args: { command: "true" } },
		});
		assert.equal(recovered.status, "working");
		assert.equal(recovered.stopped, false);
		assert.equal(recovered.isStreaming, true);

		sendNativeInput(
			dispatched.terminalServer,
			dispatched.terminalSession,
			"finish terminal follow-up",
		);
		const followedUp = await waitFor(async () => {
			const records = await client.request("list");
			const job = records.find((record) => record.id === dispatched.id);
			const outputFile = job
				? join(job.worktreePath, `agent-${dispatched.id}.txt`)
				: undefined;
			return job?.status === "complete" &&
				job.recap &&
				outputFile &&
				existsSync(outputFile) &&
				/follow-up/.test(readFileSync(outputFile, "utf8"))
				? job
				: undefined;
		}, 12_000);
		assert.match(
			readFileSync(
				join(followedUp.worktreePath, `agent-${dispatched.id}.txt`),
				"utf8",
			),
			/follow-up/,
		);

		const worktree = followedUp.worktreePath;
		await client.request("remove", { jobId: dispatched.id });
		assert.equal(existsSync(worktree), false);
		assert.throws(() =>
			execFileSync(
				"tmux",
				["-L", terminalServer, "has-session", "-t", dispatched.terminalSession],
				{ stdio: "ignore" },
			),
		);
	} finally {
		client.close();
		if (terminalServer) {
			try {
				execFileSync("tmux", ["-L", terminalServer, "kill-server"], {
					stdio: "ignore",
				});
			} catch {
				// The last removed session normally shuts the private server down.
			}
		}
		supervisor.kill("SIGTERM");
		await Promise.race([
			new Promise((resolve) => supervisor.once("close", resolve)),
			sleep(3_000),
		]);
		rmSync(root, { recursive: true, force: true });
	}

	assert.equal(supervisorError, "");
});
