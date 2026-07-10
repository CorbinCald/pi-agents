#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { appendFile, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { dirname, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

const ROOT =
	process.env.PI_AGENTS_ROOT ||
	join(process.env.HOME || ".", ".pi", "agent", "agents");
const SOCKET_PATH = join(ROOT, "supervisor.sock");
const LOCK_PATH = join(ROOT, "supervisor.lock");
const LOG_PATH = join(ROOT, "supervisor.log");
const JOBS_DIR = join(ROOT, "jobs");
const SESSIONS_DIR = join(ROOT, "sessions");
const WORKTREES_DIR = join(ROOT, "worktrees");
const RECAP_MODEL = "openai/gpt-5.6-luna";
const RECAP_THINKING = "medium";
const MAX_RECAP_INPUT_CHARS = 48_000;
const MAX_EVENT_TEXT_CHARS = 24_000;
const REQUEST_TIMEOUT_MS = 120_000;
const RECAP_TIMEOUT_MS = 180_000;
const IDLE_WORKER_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_BACKEND =
	process.env.PI_AGENTS_BACKEND === "rpc" ? "rpc" : "terminal";
const TMUX_SERVER = `pi-agents-${createHash("sha1").update(ROOT).digest("hex").slice(0, 12)}`;
const TMUX_CONFIG_PATH = join(ROOT, "tmux.conf");

const piInvocation = (() => {
	try {
		const value = JSON.parse(process.env.PI_AGENTS_PI_INVOCATION || "");
		if (typeof value.command === "string" && Array.isArray(value.argsPrefix))
			return value;
	} catch {
		// Fall through.
	}
	return { command: "pi", argsPrefix: [] };
})();

mkdirSync(ROOT, { recursive: true, mode: 0o700 });
mkdirSync(JOBS_DIR, { recursive: true, mode: 0o700 });
mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
mkdirSync(WORKTREES_DIR, { recursive: true, mode: 0o700 });

function log(message, error) {
	const detail = error ? `\n${error?.stack || String(error)}` : "";
	try {
		appendFileSync(
			LOG_PATH,
			`[${new Date().toISOString()}] ${message}${detail}\n`,
			{ mode: 0o600 },
		);
	} catch {
		// Logging must never take down the supervisor.
	}
}

function acquireLock() {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(LOCK_PATH, "wx", 0o600);
			writeFileSync(fd, String(process.pid));
			closeSync(fd);
			return;
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			try {
				const pid = Number(readFileSync(LOCK_PATH, "utf8"));
				if (Number.isFinite(pid)) process.kill(pid, 0);
				process.exit(0);
			} catch (probeError) {
				if (probeError?.code === "EPERM") process.exit(0);
				try {
					unlinkSync(LOCK_PATH);
				} catch {
					// Retry and let the next open report a useful error.
				}
			}
		}
	}
	throw new Error("Could not acquire the agents supervisor lock");
}

acquireLock();

const jobs = new Map();
const workers = new Map();
const terminalRunning = new Set();
const clients = new Set();
const generations = new Map();
const streamBroadcastTimes = new Map();
let gitQueue = Promise.resolve();
let shuttingDown = false;

function statePath(id) {
	return join(JOBS_DIR, id, "state.json");
}

function publicJob(job) {
	const {
		projectTrusted: _projectTrusted,
		streamingText: _streamingText,
		lastStreamPersistAt: _lastStreamPersistAt,
		lastAssistantText: _lastAssistantText,
		terminalStopping: _terminalStopping,
		...state
	} = job;
	return {
		...state,
		isRunning:
			job.backend === "terminal"
				? terminalRunning.has(job.id)
				: workers.has(job.id),
		isStreaming: Boolean(job.isStreaming),
	};
}

function persistJob(job) {
	const dir = join(JOBS_DIR, job.id);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const target = statePath(job.id);
	const temp = `${target}.${process.pid}.tmp`;
	writeFileSync(
		temp,
		`${JSON.stringify({ ...job, isRunning: false }, null, 2)}\n`,
		{ mode: 0o600 },
	);
	renameSync(temp, target);
}

function send(socket, value) {
	if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

function broadcast(value) {
	for (const socket of clients) send(socket, value);
}

function emitState(job, { persist = true } = {}) {
	job.updatedAt = Date.now();
	if (persist) persistJob(job);
	broadcast({ type: "event", event: "state", job: publicJob(job) });
}

function loadJobs() {
	for (const name of readdirSync(JOBS_DIR, { withFileTypes: true })) {
		if (!name.isDirectory()) continue;
		try {
			const parsed = JSON.parse(
				readFileSync(join(JOBS_DIR, name.name, "state.json"), "utf8"),
			);
			if (!parsed || typeof parsed.id !== "string") continue;
			parsed.backend ||= "rpc";
			delete parsed.terminalStopping;
			if (parsed.backend === "terminal") {
				parsed.terminalServer ||= TMUX_SERVER;
				parsed.terminalSession ||= `pi-agent-${parsed.id}`;
			}
			parsed.isRunning = false;
			parsed.isStreaming = false;
			if (parsed.status === "working") {
				parsed.summary = "Restoring interrupted background session…";
			}
			jobs.set(parsed.id, parsed);
			generations.set(parsed.id, 0);
		} catch (error) {
			log(`Could not load job ${name.name}`, error);
		}
	}
}

loadJobs();

function nextGeneration(jobId) {
	const value = (generations.get(jobId) || 0) + 1;
	generations.set(jobId, value);
	return value;
}

function currentGeneration(jobId) {
	return generations.get(jobId) || 0;
}

function compactText(value, max = MAX_EVENT_TEXT_CHARS) {
	const text = String(value || "")
		.replace(/\s+/g, " ")
		.trim();
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

function textContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function safeMessage(message) {
	if (!message || typeof message !== "object") return message;
	if (!Array.isArray(message.content)) return message;
	return {
		...message,
		content: message.content.map((part) => {
			if (part?.type === "image") return { type: "text", text: "[image]" };
			if (part?.type === "thinking")
				return {
					type: "thinking",
					thinking: compactText(part.thinking, 2_000),
				};
			return part;
		}),
	};
}

function formatToolActivity(name, args = {}) {
	switch (name) {
		case "read":
			return `Reading ${args.path || args.file_path || "a file"}`;
		case "edit":
			return `Editing ${args.path || args.file_path || "a file"}`;
		case "write":
			return `Writing ${args.path || args.file_path || "a file"}`;
		case "bash":
			return `Running: ${compactText(args.command || "shell command", 72)}`;
		case "grep":
			return `Searching for ${args.pattern || "matches"}`;
		case "find":
			return `Finding ${args.pattern || "files"}`;
		default:
			return `Using ${name}`;
	}
}

function execFileAsync(command, args, options = {}) {
	return new Promise((resolvePromise, reject) => {
		execFile(
			command,
			args,
			{ ...options, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					error.stdout = stdout;
					error.stderr = stderr;
					reject(error);
					return;
				}
				resolvePromise({ stdout, stderr });
			},
		);
	});
}

function spawnWithInput(command, args, input, options = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, {
			...options,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolvePromise({ stdout, stderr });
			else {
				const error = new Error(
					compactText(stderr || `${command} exited ${code}`, 1_000),
				);
				error.code = code;
				reject(error);
			}
		});
		child.stdin.end(input);
	});
}

function shellQuote(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writeTmuxConfig() {
	const config = [
		"set -g status off",
		"set -g prefix None",
		"set -g prefix2 None",
		"set -g mouse on",
		"set -g history-limit 100000",
		'bind-key -T root WheelUpPane if-shell -F "#{||:#{pane_in_mode},#{mouse_any_flag}}" { send-keys -M } { copy-mode -e ; send-keys -X -N 5 scroll-up }',
		"set -g focus-events on",
		"set -g extended-keys always",
		"set -g extended-keys-format csi-u",
		"set -s escape-time 0",
		"set -g remain-on-exit off",
		"set -g detach-on-destroy on",
	].join("\n");
	writeFileSync(TMUX_CONFIG_PATH, `${config}\n`, { mode: 0o600 });
}

function tmuxCommand(...args) {
	return ["-L", TMUX_SERVER, "-f", TMUX_CONFIG_PATH, ...args];
}

async function hasTerminalSession(job) {
	if (!job.terminalSession) return false;
	try {
		await execFileAsync("tmux", [
			"-L",
			TMUX_SERVER,
			"has-session",
			"-t",
			job.terminalSession,
		]);
		return true;
	} catch {
		return false;
	}
}

function terminalLaunchCommand(job, initialPrompt) {
	const args = [...piInvocation.argsPrefix];
	if (job.sessionFile && existsSync(job.sessionFile)) {
		args.push("--session", job.sessionFile);
	} else {
		args.push("--session-dir", SESSIONS_DIR);
	}
	args.push("--model", `${job.model.provider}/${job.model.id}`);
	args.push("--thinking", job.thinkingLevel);
	args.push("--name", job.name);
	args.push(job.projectTrusted ? "--approve" : "--no-approve");
	if (initialPrompt) args.push(initialPrompt);

	const environment = {
		PI_AGENTS_WORKER: "1",
		PI_AGENT_JOB_ID: job.id,
		PI_AGENT_JOB_DIR: join(JOBS_DIR, job.id),
		PI_AGENTS_ROOT: ROOT,
		PI_AGENTS_TMUX_SERVER: TMUX_SERVER,
		PI_AGENTS_TMUX_SESSION: job.terminalSession,
	};
	const envArgs = Object.entries(environment).map(
		([key, value]) => `${key}=${shellQuote(value)}`,
	);
	const invocation = [piInvocation.command, ...args].map(shellQuote).join(" ");
	return `exec env ${envArgs.join(" ")} ${invocation}`;
}

async function ensureTerminal(job, initialPrompt) {
	job.backend = "terminal";
	job.terminalServer = TMUX_SERVER;
	job.terminalSession ||= `pi-agent-${job.id}`;
	writeTmuxConfig();
	await execFileAsync("tmux", ["-V"]);

	let serverRunning = false;
	try {
		await execFileAsync("tmux", ["-L", TMUX_SERVER, "list-sessions"]);
		serverRunning = true;
	} catch {
		// The first managed session will start the private server with this config.
	}
	if (serverRunning) {
		await execFileAsync("tmux", [
			"-L",
			TMUX_SERVER,
			"source-file",
			TMUX_CONFIG_PATH,
		]);
	}

	if (await hasTerminalSession(job)) {
		terminalRunning.add(job.id);
		return false;
	}
	await execFileAsync(
		"tmux",
		tmuxCommand(
			"new-session",
			"-d",
			"-s",
			job.terminalSession,
			"-x",
			"120",
			"-y",
			"40",
			"-c",
			job.cwd,
			terminalLaunchCommand(job, initialPrompt),
		),
	);
	terminalRunning.add(job.id);
	persistJob(job);
	return true;
}

async function stopTerminal(job) {
	if (!job.terminalSession) return;
	job.terminalStopping = true;
	try {
		await execFileAsync("tmux", [
			"-L",
			TMUX_SERVER,
			"kill-session",
			"-t",
			job.terminalSession,
		]);
	} catch {
		// The session already exited.
	}
	terminalRunning.delete(job.id);
	setTimeout(() => {
		delete job.terminalStopping;
		if (jobs.has(job.id)) persistJob(job);
	}, 1_000).unref();
}

async function sendTerminalInput(job, text) {
	const buffer = `pi-agent-${job.id}-${Date.now()}`;
	await spawnWithInput(
		"tmux",
		["-L", TMUX_SERVER, "load-buffer", "-b", buffer, "-"],
		text,
	);
	await execFileAsync("tmux", [
		"-L",
		TMUX_SERVER,
		"paste-buffer",
		"-d",
		"-b",
		buffer,
		"-t",
		job.terminalSession,
	]);
	await execFileAsync("tmux", [
		"-L",
		TMUX_SERVER,
		"send-keys",
		"-t",
		job.terminalSession,
		"Enter",
	]);
}

function withGitQueue(fn) {
	const run = gitQueue.then(fn, fn);
	gitQueue = run.catch(() => undefined);
	return run;
}

function slug(value, fallback = "task") {
	return (
		String(value || "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 32) || fallback
	);
}

function autoName(prompt) {
	const cleaned = String(prompt)
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[/!]+/, "");
	const words = cleaned.split(" ").slice(0, 6).join(" ");
	return words.length > 42 ? `${words.slice(0, 41)}…` : words || "New agent";
}

async function createIsolatedWorktree(job) {
	let repoRoot;
	let baseRef;
	try {
		repoRoot = (
			await execFileAsync("git", [
				"-C",
				job.originalCwd,
				"rev-parse",
				"--show-toplevel",
			])
		).stdout.trim();
		baseRef = (
			await execFileAsync("git", ["-C", job.originalCwd, "rev-parse", "HEAD"])
		).stdout.trim();
	} catch {
		job.cwd = job.originalCwd;
		job.isolated = false;
		job.summary = "Working in a non-Git directory (not isolated)";
		return;
	}

	const repoKey = createHash("sha1")
		.update(repoRoot)
		.digest("hex")
		.slice(0, 12);
	const worktreePath = join(WORKTREES_DIR, repoKey, job.id);
	const branch = `pi-agent/${job.id}-${slug(job.name)}`;
	const relativeCwd = relative(repoRoot, job.originalCwd);
	if (relativeCwd.startsWith(`..${sep}`) || relativeCwd === "..") {
		throw new Error("Working directory is outside its Git repository");
	}

	await withGitQueue(async () => {
		await mkdir(dirname(worktreePath), { recursive: true, mode: 0o700 });
		await execFileAsync("git", [
			"-C",
			repoRoot,
			"worktree",
			"add",
			"-b",
			branch,
			worktreePath,
			baseRef,
		]);
	});

	const workerCwd =
		relativeCwd && relativeCwd !== "."
			? join(worktreePath, relativeCwd)
			: worktreePath;
	if (!existsSync(workerCwd) || !statSync(workerCwd).isDirectory()) {
		throw new Error(
			`The matching worktree subdirectory does not exist: ${relativeCwd}`,
		);
	}

	job.repoRoot = repoRoot;
	job.worktreePath = worktreePath;
	job.branch = branch;
	job.cwd = workerCwd;
	job.isolated = true;
	job.summary = `Starting in isolated branch ${branch}`;
}

async function removeWorktree(job) {
	if (!job.worktreePath || !job.repoRoot) return;
	await withGitQueue(async () => {
		try {
			await execFileAsync("git", [
				"-C",
				job.repoRoot,
				"worktree",
				"remove",
				"--force",
				job.worktreePath,
			]);
		} catch (error) {
			if (existsSync(job.worktreePath)) throw error;
			await execFileAsync("git", ["-C", job.repoRoot, "worktree", "prune"]);
		}
		if (job.branch) {
			try {
				await execFileAsync("git", [
					"-C",
					job.repoRoot,
					"branch",
					"-D",
					job.branch,
				]);
			} catch (error) {
				log(
					`Worktree removed but branch ${job.branch} could not be deleted`,
					error,
				);
			}
		}
	});
}

class RpcWorker {
	constructor(job, onEvent, onExit) {
		this.job = job;
		this.onEvent = onEvent;
		this.onExit = onExit;
		this.decoder = new StringDecoder("utf8");
		this.buffer = "";
		this.pending = new Map();
		this.nextId = 1;
		this.closed = false;
		this.intentional = false;
		this.stderr = "";
	}

	start() {
		const args = ["--mode", "rpc"];
		if (this.job.sessionFile && existsSync(this.job.sessionFile)) {
			args.push("--session", this.job.sessionFile);
		} else {
			args.push("--session-dir", SESSIONS_DIR);
		}
		args.push("--model", `${this.job.model.provider}/${this.job.model.id}`);
		args.push("--thinking", this.job.thinkingLevel);
		args.push("--name", this.job.name);
		if (this.job.projectTrusted) args.push("--approve");

		this.proc = spawn(
			piInvocation.command,
			[...piInvocation.argsPrefix, ...args],
			{
				cwd: this.job.cwd,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					PI_AGENTS_WORKER: "1",
					PI_AGENT_JOB_ID: this.job.id,
					PI_AGENT_JOB_DIR: join(JOBS_DIR, this.job.id),
				},
			},
		);

		this.proc.stdout.on("data", (chunk) => this.readChunk(chunk));
		this.proc.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			this.stderr = `${this.stderr}${text}`.slice(-32_000);
			void appendFile(join(JOBS_DIR, this.job.id, "worker.log"), text).catch(
				() => undefined,
			);
		});
		this.proc.on("error", (error) => this.finish(error));
		this.proc.on("close", (code, signal) =>
			this.finish(undefined, code, signal),
		);
	}

	readChunk(chunk) {
		this.buffer += this.decoder.write(chunk);
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) break;
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line) continue;
			try {
				this.handle(JSON.parse(line));
			} catch {
				void appendFile(
					join(JOBS_DIR, this.job.id, "worker.log"),
					`[non-json stdout] ${line}\n`,
				).catch(() => undefined);
			}
		}
	}

	handle(message) {
		if (message?.type === "response" && typeof message.id === "string") {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.success) pending.resolve(message.data);
			else
				pending.reject(
					new Error(
						message.error || `Worker command failed: ${message.command}`,
					),
				);
			return;
		}
		this.onEvent(message);
	}

	request(type, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
		if (this.closed || !this.proc?.stdin.writable)
			return Promise.reject(new Error("Agent worker is not running"));
		const id = `s-${this.nextId++}`;
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Agent worker request timed out: ${type}`));
			}, timeoutMs);
			this.pending.set(id, { resolve: resolvePromise, reject, timer });
			this.proc.stdin.write(
				`${JSON.stringify({ id, type, ...payload })}\n`,
				(error) => {
					if (!error) return;
					const pending = this.pending.get(id);
					if (!pending) return;
					this.pending.delete(id);
					clearTimeout(pending.timer);
					reject(error);
				},
			);
		});
	}

	sendRaw(value) {
		if (this.closed || !this.proc?.stdin.writable)
			throw new Error("Agent worker is not running");
		this.proc.stdin.write(`${JSON.stringify(value)}\n`);
	}

	stop() {
		this.intentional = true;
		if (!this.proc || this.closed) return;
		try {
			if (process.platform !== "win32" && this.proc.pid)
				process.kill(-this.proc.pid, "SIGTERM");
			else this.proc.kill("SIGTERM");
		} catch {
			// The process already exited.
		}
		setTimeout(() => {
			if (this.closed || !this.proc) return;
			try {
				if (process.platform !== "win32" && this.proc.pid)
					process.kill(-this.proc.pid, "SIGKILL");
				else this.proc.kill("SIGKILL");
			} catch {
				// The process already exited.
			}
		}, 3_000).unref();
	}

	finish(error, code, signal) {
		if (this.closed) return;
		this.closed = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(
				error ||
					new Error(`Agent worker exited (${signal || code || "unknown"})`),
			);
		}
		this.pending.clear();
		this.onExit({
			error,
			code,
			signal,
			intentional: this.intentional,
			stderr: this.stderr,
		});
	}
}

async function ensureWorker(job) {
	const existing = workers.get(job.id);
	if (existing && !existing.closed) return existing;

	// An extension UI request belongs to the old RPC process and cannot be
	// answered after that process exits. Preserve the question, but route the
	// user's eventual answer as a normal resumed-session prompt.
	job.pendingUi = undefined;
	const worker = new RpcWorker(
		job,
		(event) => handleWorkerEvent(job, event),
		(info) => handleWorkerExit(job, worker, info),
	);
	workers.set(job.id, worker);
	worker.start();

	try {
		const state = await worker.request("get_state", {}, 30_000);
		if (state?.sessionFile) job.sessionFile = state.sessionFile;
		if (state?.sessionId) job.sessionId = state.sessionId;
		job.isStreaming = Boolean(state?.isStreaming);
		persistJob(job);
		return worker;
	} catch (error) {
		worker.stop();
		throw error;
	}
}

function broadcastWorkerEvent(job, event) {
	const now = Date.now();
	const lastStreamingBroadcast = streamBroadcastTimes.get(job.id) || 0;
	if (event.type === "message_update" && now - lastStreamingBroadcast < 75)
		return;
	if (event.type === "message_update") streamBroadcastTimes.set(job.id, now);
	let data = event;
	if (event.type === "message_update") {
		data = {
			type: event.type,
			assistantMessageEvent: event.assistantMessageEvent,
		};
	} else if (event.type === "message_end") {
		data = { type: event.type, message: safeMessage(event.message) };
	} else if (event.type === "tool_execution_update") {
		data = {
			type: event.type,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
		};
	}
	broadcast({ type: "event", event: "job_event", jobId: job.id, data });
}

function handleWorkerEvent(job, event) {
	broadcastWorkerEvent(job, event);

	switch (event.type) {
		case "agent_start":
			nextGeneration(job.id);
			job.status = "working";
			job.stopped = false;
			job.failed = false;
			job.error = undefined;
			job.recap = undefined;
			job.recapPending = false;
			job.waitingFor = undefined;
			job.pendingUi = undefined;
			job.isStreaming = true;
			job.summary = "Starting…";
			emitState(job);
			break;
		case "message_update": {
			const delta = event.assistantMessageEvent?.delta;
			if (
				event.assistantMessageEvent?.type === "text_delta" &&
				typeof delta === "string"
			) {
				job.streamingText = `${job.streamingText || ""}${delta}`.slice(-8_000);
				const latest = job.streamingText.split("\n").filter(Boolean).at(-1);
				if (latest) job.summary = compactText(latest, 96);
				const now = Date.now();
				if (!job.lastStreamPersistAt || now - job.lastStreamPersistAt > 750) {
					job.lastStreamPersistAt = now;
					emitState(job);
				}
			}
			break;
		}
		case "message_end": {
			const message = event.message;
			if (message?.role === "assistant") {
				const text = textContent(message.content);
				if (text) {
					job.lastAssistantText = text.slice(-16_000);
					job.summary = compactText(
						text.split("\n").filter(Boolean).at(-1) || text,
						96,
					);
				}
				job.streamingText = "";
				if (message.stopReason === "error") {
					job.failed = true;
					job.error = message.errorMessage || "The model returned an error";
				}
			}
			emitState(job);
			break;
		}
		case "tool_execution_start":
			job.summary = formatToolActivity(event.toolName, event.args);
			emitState(job);
			break;
		case "extension_ui_request": {
			if (!["select", "confirm", "input", "editor"].includes(event.method))
				break;
			job.pendingUi = {
				id: event.id,
				method: event.method,
				title: event.title,
				message: event.message,
				placeholder: event.placeholder,
				prefill: event.prefill,
				options: event.options,
			};
			job.waitingFor = event.message || event.title || "Input needed";
			job.summary = compactText(job.waitingFor, 96);
			job.status = "needs_input";
			job.isStreaming = false;
			emitState(job);
			break;
		}
		case "auto_retry_start":
			job.status = "working";
			job.summary = `Retrying after an API error (attempt ${event.attempt})`;
			emitState(job);
			break;
		case "agent_settled":
			job.isStreaming = false;
			if (!job.pendingUi) void createCompletionRecap(job);
			break;
		case "extension_error":
			job.summary = compactText(event.error || "Extension error", 96);
			emitState(job);
			break;
	}
}

function handleWorkerExit(job, worker, info) {
	if (workers.get(job.id) !== worker) return;
	workers.delete(job.id);
	job.isStreaming = false;
	if (shuttingDown || info.intentional) {
		persistJob(job);
		broadcast({ type: "event", event: "state", job: publicJob(job) });
		return;
	}

	job.status = "complete";
	job.failed = true;
	job.error = compactText(
		info.stderr ||
			info.error?.message ||
			`Worker exited (${info.signal || info.code})`,
		500,
	);
	job.summary = compactText(job.error, 96);
	job.completedAt = Date.now();
	emitState(job);
}

function handleTerminalWorkerEvent(job, eventType, data = {}) {
	terminalRunning.add(job.id);
	job.backend = "terminal";
	job.terminalServer = TMUX_SERVER;
	job.terminalSession ||= `pi-agent-${job.id}`;

	switch (eventType) {
		case "session_start":
			if (typeof data.sessionFile === "string")
				job.sessionFile = data.sessionFile;
			if (typeof data.sessionId === "string") job.sessionId = data.sessionId;
			if (typeof data.cwd === "string") job.cwd = data.cwd;
			if (
				data.model &&
				typeof data.model.provider === "string" &&
				typeof data.model.id === "string"
			) {
				job.model = data.model;
			}
			if (typeof data.thinkingLevel === "string") {
				job.thinkingLevel = data.thinkingLevel;
			}
			emitState(job);
			break;
		case "agent_start":
			nextGeneration(job.id);
			job.status = "working";
			job.stopped = false;
			job.failed = false;
			job.error = undefined;
			job.recap = undefined;
			job.recapPending = false;
			job.waitingFor = undefined;
			job.pendingUi = undefined;
			job.isStreaming = true;
			job.summary = "Working…";
			emitState(job);
			break;
		case "message_end":
			if (typeof data.text === "string" && data.text.trim()) {
				job.lastAssistantText = data.text.slice(-16_000);
				job.summary = compactText(
					data.text.split("\n").filter(Boolean).at(-1) || data.text,
					96,
				);
			}
			if (data.stopReason === "error") {
				job.failed = true;
				job.error =
					compactText(data.errorMessage, 1_000) ||
					"The model returned an error";
			}
			emitState(job);
			break;
		case "tool_execution_start":
			if (typeof data.toolName === "string") {
				job.summary = formatToolActivity(data.toolName, data.args);
				if (/ask|question|confirm|input/i.test(data.toolName)) {
					job.status = "needs_input";
					job.waitingFor = "The session is waiting for input";
					job.isStreaming = false;
				}
				emitState(job);
			}
			break;
		case "agent_settled":
			job.isStreaming = false;
			void createCompletionRecap(job);
			break;
		case "model_select":
			if (
				data.model &&
				typeof data.model.provider === "string" &&
				typeof data.model.id === "string"
			) {
				job.model = data.model;
				emitState(job);
			}
			break;
		case "thinking_level_select":
			if (typeof data.level === "string") {
				job.thinkingLevel = data.level;
				emitState(job);
			}
			break;
		case "session_info_changed":
			if (typeof data.name === "string" && data.name.trim()) {
				job.name = compactText(data.name, 80);
				job.userRenamed = true;
				emitState(job);
			}
			break;
		case "session_shutdown":
			nextGeneration(job.id);
			terminalRunning.delete(job.id);
			if (job.terminalStopping) {
				persistJob(job);
				broadcast({ type: "event", event: "state", job: publicJob(job) });
				break;
			}
			job.status = "complete";
			job.stopped = true;
			job.isStreaming = false;
			job.recapPending = false;
			job.summary = "Exited native Pi session";
			job.completedAt = Date.now();
			emitState(job);
			break;
	}
	return publicJob(job);
}

function serializeMessages(messages) {
	const sections = [];
	for (const message of messages || []) {
		if (!message || typeof message !== "object") continue;
		if (message.role === "user") {
			sections.push(`[User]\n${textContent(message.content)}`);
		} else if (message.role === "assistant") {
			const parts = [];
			for (const part of message.content || []) {
				if (part?.type === "text") parts.push(part.text);
				else if (part?.type === "toolCall")
					parts.push(
						`[Tool call: ${part.name} ${JSON.stringify(part.arguments || {})}]`,
					);
			}
			sections.push(`[Assistant]\n${parts.join("\n")}`);
		} else if (message.role === "toolResult") {
			sections.push(
				`[Tool result: ${message.toolName}]\n${textContent(message.content).slice(0, 2_000)}`,
			);
		} else if (message.role === "bashExecution") {
			sections.push(
				`[Shell: ${message.command}]\n${String(message.output || "").slice(0, 2_000)}`,
			);
		}
	}
	const text = sections.join("\n\n");
	if (text.length <= MAX_RECAP_INPUT_CHARS) return text;
	return `[Earlier transcript omitted]\n\n${text.slice(-MAX_RECAP_INPUT_CHARS)}`;
}

function parseRecapJson(text) {
	const cleaned = String(text || "")
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start < 0 || end <= start)
		throw new Error("Recap model did not return JSON");
	const parsed = JSON.parse(cleaned.slice(start, end + 1));
	if (!["complete", "needs_input"].includes(parsed.status))
		throw new Error("Recap status is invalid");
	return {
		status: parsed.status,
		title: compactText(parsed.title, 48),
		summary: compactText(parsed.summary, 96),
		recap: compactText(parsed.recap, 800),
		question: compactText(parsed.question, 500),
	};
}

async function runRecapModel(job, messages) {
	const transcript = serializeMessages(messages);
	const prompt = `You classify and recap a completed turn from a background Pi coding-agent session.\n\nReturn exactly one JSON object with these string fields:\n- status: "complete" if the requested work is done, otherwise "needs_input" only when the assistant explicitly needs a user decision, answer, credential, permission, or missing information before it can continue\n- title: a concise task name, at most 6 words\n- summary: one status sentence, at most 64 characters\n- recap: 1-3 concise sentences describing what was accomplished and the most important result; do not address the user directly\n- question: the exact decision or information needed, or an empty string when complete\n\nDo not use markdown fences. Do not classify a routine offer such as "let me know if you need anything" as needs_input.\n\nSession directory: ${job.cwd}\nInitial task: ${job.prompt}\n\n<transcript>\n${transcript}\n</transcript>`;

	const args = [
		...piInvocation.argsPrefix,
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-tools",
		"--model",
		RECAP_MODEL,
		"--thinking",
		RECAP_THINKING,
	];

	return new Promise((resolvePromise, reject) => {
		const child = spawn(piInvocation.command, args, {
			cwd: job.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PI_AGENTS_RECAP: "1" },
		});
		let stdout = "";
		let stderr = "";
		let finalText = "";
		let buffer = "";
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(new Error("Completion recap timed out"));
		}, RECAP_TIMEOUT_MS);

		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			stdout += text;
			buffer += text;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				try {
					const event = JSON.parse(line);
					if (
						event.type === "message_end" &&
						event.message?.role === "assistant"
					) {
						finalText = textContent(event.message.content);
					}
				} catch {
					// Keep plain output as a fallback.
				}
			}
		});
		child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(
					new Error(
						compactText(stderr || `Recap process exited ${code}`, 1_000),
					),
				);
				return;
			}
			try {
				resolvePromise(parseRecapJson(finalText || stdout));
			} catch (error) {
				reject(error);
			}
		});
		child.stdin.end(prompt);
	});
}

function fallbackRecap(job) {
	const text = compactText(
		job.lastAssistantText || job.error || job.summary || "Session finished",
		800,
	);
	const needsInput =
		!job.failed &&
		(/\?\s*$/.test(text) ||
			/\b(need|please provide|which|should i|would you like)\b/i.test(text));
	return {
		status: needsInput ? "needs_input" : "complete",
		title: job.name,
		summary: compactText(text, 96),
		recap: text,
		question: needsInput ? text : "",
	};
}

async function createCompletionRecap(job) {
	const generation = currentGeneration(job.id);
	job.status = "complete";
	job.recapPending = true;
	job.summary = "Preparing completion recap…";
	job.completedAt = Date.now();
	emitState(job);

	let messages = [];
	try {
		const worker = workers.get(job.id);
		if (worker && !worker.closed) {
			const result = await worker.request("get_messages");
			messages = result?.messages || [];
		} else if (job.sessionFile) {
			messages = readSessionMessages(job.sessionFile);
		}
	} catch (error) {
		log(`Could not read messages for recap ${job.id}`, error);
	}

	let result;
	try {
		result = await runRecapModel(job, messages);
	} catch (error) {
		log(`Completion recap failed for ${job.id}; using fallback`, error);
		result = fallbackRecap(job);
	}

	if (!jobs.has(job.id) || currentGeneration(job.id) !== generation) return;
	if (job.failed) {
		result = {
			...result,
			status: "complete",
			summary: compactText(job.error || result.summary || "Session failed", 96),
			recap: compactText(
				`Session failed: ${job.error || result.recap || "Unknown error"}`,
				800,
			),
			question: "",
		};
	}
	job.recapPending = false;
	job.status = result.status;
	job.summary = result.summary || job.summary;
	job.waitingFor =
		result.status === "needs_input"
			? result.question || result.summary
			: undefined;
	job.recap = result.status === "complete" ? result.recap : undefined;
	if (!job.userRenamed && result.title && result.title !== job.name) {
		job.name = result.title;
		const worker = workers.get(job.id);
		if (worker && !worker.closed) {
			void worker
				.request("set_session_name", { name: job.name })
				.catch((error) =>
					log(`Could not update generated session name for ${job.id}`, error),
				);
		}
	}
	emitState(job);
}

function readSessionMessages(file) {
	try {
		const entries = readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((entry) => entry?.id);
		if (entries.length === 0) return [];
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		const path = [];
		let current = entries.at(-1);
		const seen = new Set();
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			path.push(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		path.reverse();
		return path
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
	} catch (error) {
		log(`Could not parse session ${file}`, error);
		return [];
	}
}

function sortedJobs() {
	const statusOrder = { needs_input: 0, working: 1, complete: 2 };
	return [...jobs.values()].sort((a, b) => {
		if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
		const statusDiff = statusOrder[a.status] - statusOrder[b.status];
		if (statusDiff) return statusDiff;
		if (a.order !== b.order) return a.order - b.order;
		return b.updatedAt - a.updatedAt;
	});
}

async function dispatchJob(request) {
	if (typeof request.prompt !== "string" || request.prompt.trim().length < 4) {
		throw new Error("Describe the task in at least four characters");
	}
	if (
		!request.model ||
		typeof request.model.provider !== "string" ||
		typeof request.model.id !== "string"
	) {
		throw new Error("No dispatch model is selected");
	}
	const originalCwd = resolve(String(request.cwd || process.cwd()));
	if (!existsSync(originalCwd) || !statSync(originalCwd).isDirectory()) {
		throw new Error(`Working directory does not exist: ${originalCwd}`);
	}

	let id;
	do id = randomUUID().replace(/-/g, "").slice(0, 8);
	while (jobs.has(id));
	const now = Date.now();
	const job = {
		id,
		backend: DEFAULT_BACKEND,
		...(DEFAULT_BACKEND === "terminal"
			? {
					terminalServer: TMUX_SERVER,
					terminalSession: `pi-agent-${id}`,
				}
			: {}),
		name: autoName(request.prompt),
		prompt: request.prompt.trim(),
		originalCwd,
		cwd: originalCwd,
		model: request.model,
		thinkingLevel: request.thinkingLevel || "medium",
		projectTrusted: Boolean(request.projectTrusted),
		status: "working",
		summary: "Creating isolated worktree…",
		createdAt: now,
		updatedAt: now,
		pinned: false,
		order:
			Math.max(0, ...[...jobs.values()].map((item) => item.order || 0)) + 1,
		userRenamed: false,
		isRunning: false,
		isStreaming: false,
		isolated: false,
	};
	jobs.set(id, job);
	generations.set(id, 0);
	emitState(job);

	try {
		await createIsolatedWorktree(job);
		emitState(job);
		if (job.backend === "terminal") {
			await ensureTerminal(job, job.prompt);
			job.status = "working";
			job.summary = job.isolated
				? `Starting native Pi in ${job.branch}`
				: "Starting native Pi…";
			emitState(job);
		} else {
			const worker = await ensureWorker(job);
			await worker.request("prompt", { message: job.prompt });
			job.status = "working";
			job.summary = job.isolated ? `Working in ${job.branch}` : "Working…";
			emitState(job);
		}
	} catch (error) {
		job.status = "complete";
		job.failed = true;
		job.error = compactText(error?.stderr || error?.message || error, 1_000);
		job.summary = compactText(job.error, 96);
		job.completedAt = Date.now();
		emitState(job);
	}
	return publicJob(job);
}

async function respondToPendingUi(job, worker, message) {
	const pending = job.pendingUi;
	if (!pending) return false;
	let response;
	if (pending.method === "confirm") {
		const normalized = message.trim().toLowerCase();
		response = {
			type: "extension_ui_response",
			id: pending.id,
			confirmed: /^(y|yes|true|allow|ok|1)$/.test(normalized),
		};
	} else if (pending.method === "select") {
		const index = Number.parseInt(message.trim(), 10);
		const selected =
			Number.isFinite(index) && index > 0
				? pending.options?.[index - 1]
				: pending.options?.find((item) => item === message.trim());
		response = {
			type: "extension_ui_response",
			id: pending.id,
			value: selected || message.trim(),
		};
	} else {
		response = {
			type: "extension_ui_response",
			id: pending.id,
			value: message,
		};
	}
	worker.sendRaw(response);
	job.pendingUi = undefined;
	job.waitingFor = undefined;
	job.status = "working";
	job.summary = "Continuing with your answer…";
	job.isStreaming = true;
	nextGeneration(job.id);
	emitState(job);
	return true;
}

async function promptJob(job, message) {
	if (typeof message !== "string" || !message.trim())
		throw new Error("Message cannot be empty");

	if (job.backend === "terminal") {
		const launched = await ensureTerminal(job, message.trim());
		nextGeneration(job.id);
		job.status = "working";
		job.stopped = false;
		job.failed = false;
		job.error = undefined;
		job.recap = undefined;
		job.recapPending = false;
		job.waitingFor = undefined;
		job.summary = launched ? "Starting native Pi…" : "Queued your message…";
		emitState(job);
		if (!launched) await sendTerminalInput(job, message);
		return publicJob(job);
	}

	const worker = await ensureWorker(job);
	if (await respondToPendingUi(job, worker, message)) return publicJob(job);

	nextGeneration(job.id);
	job.status = "working";
	job.stopped = false;
	job.failed = false;
	job.error = undefined;
	job.recap = undefined;
	job.recapPending = false;
	job.waitingFor = undefined;
	job.summary = "Queued your message…";
	emitState(job);
	await worker.request("prompt", {
		message,
		...(job.isStreaming ? { streamingBehavior: "steer" } : {}),
	});
	return publicJob(job);
}

async function stopJob(job) {
	nextGeneration(job.id);
	if (job.backend === "terminal") {
		await stopTerminal(job);
	} else {
		const worker = workers.get(job.id);
		if (worker) {
			worker.intentional = true;
			try {
				await worker.request("abort", {}, 5_000);
			} catch {
				// Fall back to terminating the process.
			}
			worker.stop();
			workers.delete(job.id);
		}
	}
	job.status = "complete";
	job.stopped = true;
	job.isStreaming = false;
	job.recapPending = false;
	job.summary = "Stopped by user";
	job.completedAt = Date.now();
	emitState(job);
	return publicJob(job);
}

async function removeJob(job) {
	await stopJob(job);
	await removeWorktree(job);
	jobs.delete(job.id);
	generations.delete(job.id);
	streamBroadcastTimes.delete(job.id);
	await rm(join(JOBS_DIR, job.id), { recursive: true, force: true });
	broadcast({ type: "event", event: "removed", jobId: job.id });
}

async function handleRequest(message) {
	switch (message.type) {
		case "list":
			return sortedJobs().map(publicJob);
		case "dispatch":
			return dispatchJob(message);
		case "prepare_attach": {
			const job = requiredJob(message.jobId);
			if (job.backend !== "terminal") {
				throw new Error(
					"This legacy RPC session cannot be attached natively; create a new agent session",
				);
			}
			const running = await hasTerminalSession(job);
			const continuation =
				!running && job.status === "working"
					? `Continue the interrupted task from where you left off. Original task: ${job.prompt}`
					: undefined;
			await ensureTerminal(job, continuation);
			emitState(job);
			return publicJob(job);
		}
		case "worker_event": {
			const job = requiredJob(message.jobId);
			if (job.backend !== "terminal") {
				throw new Error("Worker events are only valid for terminal sessions");
			}
			return handleTerminalWorkerEvent(
				job,
				String(message.eventType || ""),
				message.data && typeof message.data === "object" ? message.data : {},
			);
		}
		case "prompt": {
			const job = requiredJob(message.jobId);
			return promptJob(job, message.message);
		}
		case "abort": {
			const job = requiredJob(message.jobId);
			if (job.backend === "terminal" && job.terminalSession) {
				await execFileAsync("tmux", [
					"-L",
					TMUX_SERVER,
					"send-keys",
					"-t",
					job.terminalSession,
					"Escape",
				]);
			} else {
				const worker = workers.get(job.id);
				if (worker) await worker.request("abort");
			}
			return publicJob(job);
		}
		case "messages": {
			const job = requiredJob(message.jobId);
			if (job.backend !== "terminal") {
				const worker = workers.get(job.id);
				if (worker && !worker.closed) {
					return (await worker.request("get_messages")) || { messages: [] };
				}
			}
			return {
				messages: job.sessionFile ? readSessionMessages(job.sessionFile) : [],
			};
		}
		case "rename": {
			const job = requiredJob(message.jobId);
			const name = compactText(message.name, 80);
			if (!name) throw new Error("Name cannot be empty");
			job.name = name;
			job.userRenamed = true;
			if (job.backend !== "terminal") {
				const worker = workers.get(job.id);
				if (worker && !worker.closed) {
					await worker.request("set_session_name", { name });
				}
			}
			emitState(job);
			return publicJob(job);
		}
		case "pin": {
			const job = requiredJob(message.jobId);
			job.pinned = Boolean(message.pinned);
			emitState(job);
			return publicJob(job);
		}
		case "reorder": {
			const job = requiredJob(message.jobId);
			const peers = sortedJobs().filter((item) => item.status === job.status);
			const index = peers.findIndex((item) => item.id === job.id);
			const target = peers[index + (message.direction < 0 ? -1 : 1)];
			if (target) {
				[job.order, target.order] = [target.order, job.order];
				emitState(job);
				emitState(target);
			}
			return sortedJobs().map(publicJob);
		}
		case "stop":
			return stopJob(requiredJob(message.jobId));
		case "remove":
			await removeJob(requiredJob(message.jobId));
			return undefined;
		case "ping":
			return { pid: process.pid, jobs: jobs.size };
		default:
			throw new Error(`Unknown supervisor request: ${message.type}`);
	}
}

function requiredJob(id) {
	const job = jobs.get(id);
	if (!job) throw new Error(`Unknown agent session: ${id}`);
	return job;
}

function attachClient(socket) {
	clients.add(socket);
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	socket.on("data", (chunk) => {
		buffer += decoder.write(chunk);
		while (true) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) break;
			let line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch (error) {
				send(socket, {
					type: "response",
					id: "",
					success: false,
					error: `Invalid JSON: ${error.message}`,
				});
				continue;
			}
			void handleRequest(message)
				.then((data) =>
					send(socket, {
						type: "response",
						id: String(message.id || ""),
						success: true,
						data,
					}),
				)
				.catch((error) => {
					log(`Request ${message.type} failed`, error);
					send(socket, {
						type: "response",
						id: String(message.id || ""),
						success: false,
						error: compactText(error?.stderr || error?.message || error, 2_000),
					});
				});
		}
	});
	socket.on("error", () => clients.delete(socket));
	socket.on("close", () => clients.delete(socket));
}

if (existsSync(SOCKET_PATH)) {
	try {
		unlinkSync(SOCKET_PATH);
	} catch (error) {
		log("Could not remove stale supervisor socket", error);
		process.exit(1);
	}
}

const server = net.createServer(attachClient);
server.on("error", (error) => {
	log("Supervisor server error", error);
	shutdown(1);
});
server.listen(SOCKET_PATH, () => {
	try {
		chmodSync(SOCKET_PATH, 0o600);
	} catch (error) {
		log("Could not restrict supervisor socket permissions", error);
	}
	log(`Supervisor started (pid ${process.pid})`);
	void restoreInterruptedJobs();
});

const terminalPollTimer = setInterval(() => {
	for (const jobId of [...terminalRunning]) {
		const job = jobs.get(jobId);
		if (!job) {
			terminalRunning.delete(jobId);
			continue;
		}
		void hasTerminalSession(job).then((running) => {
			if (running || !terminalRunning.delete(jobId)) return;
			job.isStreaming = false;
			if (job.status === "working" || job.status === "needs_input") {
				job.status = "complete";
				job.failed = true;
				job.error = "Native Pi session exited unexpectedly";
				job.summary = job.error;
				job.completedAt = Date.now();
			}
			emitState(job);
		});
	}
}, 2_000);

const idleWorkerTimer = setInterval(() => {
	const cutoff = Date.now() - IDLE_WORKER_TTL_MS;
	for (const job of jobs.values()) {
		if (
			job.status !== "complete" ||
			job.pinned ||
			!job.completedAt ||
			job.completedAt > cutoff
		)
			continue;
		if (job.backend === "terminal") {
			if (!terminalRunning.has(job.id)) continue;
			void stopTerminal(job).then(() => {
				persistJob(job);
				broadcast({ type: "event", event: "state", job: publicJob(job) });
			});
		} else {
			const worker = workers.get(job.id);
			if (!worker) continue;
			workers.delete(job.id);
			worker.stop();
			persistJob(job);
			broadcast({ type: "event", event: "state", job: publicJob(job) });
		}
	}
}, 60_000);

async function restoreInterruptedJobs() {
	for (const job of jobs.values()) {
		try {
			if (job.backend === "terminal") {
				if (await hasTerminalSession(job)) {
					terminalRunning.add(job.id);
					broadcast({ type: "event", event: "state", job: publicJob(job) });
					continue;
				}
				if (job.status !== "working") continue;
				job.summary = "Resuming after supervisor restart…";
				emitState(job);
				await ensureTerminal(
					job,
					`Continue the interrupted task from where you left off. Original task: ${job.prompt}`,
				);
				continue;
			}
			if (job.status !== "working") continue;
			const worker = await ensureWorker(job);
			job.summary = "Resuming after supervisor restart…";
			emitState(job);
			await worker.request("prompt", {
				message: "Continue the interrupted task from where you left off.",
			});
		} catch (error) {
			job.status = "complete";
			job.failed = true;
			job.error = compactText(error?.message || error, 1_000);
			job.summary = compactText(job.error, 96);
			emitState(job);
		}
	}
}

function shutdown(code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	clearInterval(idleWorkerTimer);
	clearInterval(terminalPollTimer);
	for (const worker of workers.values()) worker.stop();
	workers.clear();
	for (const socket of clients) socket.destroy();
	clients.clear();
	server.close(() => process.exit(code));
	try {
		if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
	} catch {
		// Ignore shutdown cleanup races.
	}
	try {
		if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
	} catch {
		// Ignore shutdown cleanup races.
	}
	setTimeout(() => process.exit(code), 2_000).unref();
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
process.on("uncaughtException", (error) => {
	log("Uncaught supervisor exception", error);
	shutdown(1);
});
process.on("unhandledRejection", (error) => {
	log("Unhandled supervisor rejection", error);
});
process.on("exit", () => {
	try {
		if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
		if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
	} catch {
		// Best effort only.
	}
});
