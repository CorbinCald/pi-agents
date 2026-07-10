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
			PI_AGENTS_BACKEND: "rpc",
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

		const messageResult = await client.request("messages", { jobId: first.id });
		assert.equal(
			messageResult.messages.filter((message) => message.role === "assistant")
				.length,
			1,
		);

		await client.request("prompt", { jobId: second.id, message: "blue" });
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
	} finally {
		client.close();
		supervisor.kill("SIGTERM");
		await Promise.race([
			new Promise((resolve) => supervisor.once("close", resolve)),
			sleep(3_000),
		]);
		rmSync(root, { recursive: true, force: true });
	}

	assert.equal(supervisorError, "");
});

test("terminal backend keeps a native worker alive across clients and accepts follow-ups", {
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
		await client.request("prepare_attach", { jobId: dispatched.id });
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

		await client.request("prompt", {
			jobId: dispatched.id,
			message: "finish terminal follow-up",
		});
		const followedUp = await waitFor(async () => {
			const records = await client.request("list");
			const job = records.find((record) => record.id === dispatched.id);
			return job?.status === "complete" &&
				job.recap &&
				existsSync(join(job.worktreePath, `agent-${dispatched.id}.txt`))
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
