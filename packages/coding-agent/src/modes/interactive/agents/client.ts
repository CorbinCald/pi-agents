import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../../../config.ts";
import type { AgentColor, AgentRecord, DispatchRequest, SupervisorEvent } from "./types.ts";

const ROOT = join(getAgentDir(), "agents");
const SOCKET_PATH = join(ROOT, "supervisor.sock");
const PACKAGED_SUPERVISOR_PATH = fileURLToPath(new URL("./supervisor.mjs", import.meta.url));
const SUPERVISOR_PATH = existsSync(PACKAGED_SUPERVISOR_PATH)
	? PACKAGED_SUPERVISOR_PATH
	: join(dirname(process.execPath), "agents", "supervisor.mjs");
const SUPERVISOR_RUNTIME = /^(node|nodejs)(\.exe)?$/.test(basename(process.execPath).toLowerCase())
	? process.execPath
	: "node";
const CONNECT_TIMEOUT_MS = 7_500;
const REQUEST_TIMEOUT_MS = 120_000;
const SUPERVISOR_UPGRADE_TIMEOUT_MS = 5_000;
const MIN_SUPERVISOR_PROTOCOL_VERSION = 6;

type Listener = (event: SupervisorEvent) => void;
type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type WireMessage = {
	type?: unknown;
	id?: unknown;
	success?: unknown;
	data?: unknown;
	error?: unknown;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPiInvocation(): { command: string; argsPrefix: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, argsPrefix: [currentScript] };
	}

	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, argsPrefix: [] };
	}

	return { command: "pi", argsPrefix: [] };
}

export function supervisorSocketExists(): boolean {
	return existsSync(SOCKET_PATH);
}

export class SupervisorClient {
	private socket?: net.Socket;
	private decoder = new StringDecoder("utf8");
	private buffer = "";
	private nextId = 1;
	private pending = new Map<string, PendingRequest>();
	private listeners = new Set<Listener>();
	private connecting?: Promise<void>;
	private protocolCheck?: Promise<void>;
	private protocolCurrent = false;
	private closed = false;

	onEvent(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async connectIfRunning(): Promise<boolean> {
		if (!supervisorSocketExists()) return false;
		try {
			await this.connect(false);
			return true;
		} catch {
			return false;
		}
	}

	async connect(startIfNeeded = true): Promise<void> {
		if (this.socket && !this.socket.destroyed) return;
		if (this.closed) throw new Error("Agents supervisor client is closed");
		if (this.connecting) return this.connecting;

		this.connecting = this.connectWithRetry(startIfNeeded).finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private async connectWithRetry(startIfNeeded: boolean): Promise<void> {
		try {
			await this.openSocket();
			return;
		} catch (error) {
			if (!startIfNeeded) throw error;
		}

		await this.startSupervisor();
		const deadline = Date.now() + CONNECT_TIMEOUT_MS;
		let lastError: unknown;
		while (Date.now() < deadline) {
			try {
				await this.openSocket();
				return;
			} catch (error) {
				lastError = error;
				await sleep(75);
			}
		}
		throw new Error(`Agents supervisor did not start: ${String(lastError)}`);
	}

	private async startSupervisor(): Promise<void> {
		await mkdir(ROOT, { recursive: true, mode: 0o700 });
		const child = spawn(SUPERVISOR_RUNTIME, [SUPERVISOR_PATH], {
			detached: true,
			stdio: "ignore",
			env: {
				...process.env,
				PI_AGENTS_ROOT: ROOT,
				PI_AGENTS_PI_INVOCATION: JSON.stringify(getPiInvocation()),
			},
		});
		child.unref();
	}

	private async restartOutdatedSupervisor(): Promise<void> {
		const status = await this.request<{ pid?: unknown }>("ping");
		const pid = status.pid;
		if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
			throw new Error("The running Agents supervisor cannot be upgraded safely");
		}

		const socket = this.socket;
		this.socket = undefined;
		socket?.destroy();
		try {
			process.kill(pid, "SIGTERM");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}

		const deadline = Date.now() + SUPERVISOR_UPGRADE_TIMEOUT_MS;
		while (existsSync(SOCKET_PATH)) {
			if (Date.now() >= deadline) {
				throw new Error("Timed out while upgrading the Agents supervisor");
			}
			await sleep(50);
		}
		await this.connect(true);
	}

	private async checkSupervisorProtocol(): Promise<void> {
		const status = await this.request<{ protocolVersion?: unknown }>("ping");
		if (typeof status.protocolVersion !== "number" || status.protocolVersion < MIN_SUPERVISOR_PROTOCOL_VERSION) {
			await this.restartOutdatedSupervisor();
			const upgraded = await this.request<{ protocolVersion?: unknown }>("ping");
			if (
				typeof upgraded.protocolVersion !== "number" ||
				upgraded.protocolVersion < MIN_SUPERVISOR_PROTOCOL_VERSION
			) {
				throw new Error("Agents supervisor upgrade did not take effect");
			}
		}
		this.protocolCurrent = true;
	}

	private async ensureCurrentSupervisor(): Promise<void> {
		if (this.protocolCurrent) return;
		this.protocolCheck ??= this.checkSupervisorProtocol().finally(() => {
			this.protocolCheck = undefined;
		});
		await this.protocolCheck;
	}

	private openSocket(): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = net.createConnection(SOCKET_PATH);
			let settled = false;
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				socket.destroy();
				reject(error);
			};
			const timer = setTimeout(() => fail(new Error("Connection timed out")), 750);

			socket.once("error", fail);
			socket.once("connect", () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				socket.removeListener("error", fail);
				this.attachSocket(socket);
				resolve();
			});
		});
	}

	private attachSocket(socket: net.Socket): void {
		this.socket?.destroy();
		this.socket = socket;
		this.buffer = "";
		this.decoder = new StringDecoder("utf8");
		socket.on("data", (chunk) => this.readChunk(chunk));
		socket.on("error", (error) => this.handleDisconnect(socket, error));
		socket.on("close", () => this.handleDisconnect(socket, new Error("Agents supervisor disconnected")));
	}

	private readChunk(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline < 0) break;
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line) continue;
			try {
				this.handleMessage(JSON.parse(line));
			} catch {
				// Ignore malformed records from a stale/incompatible supervisor.
			}
		}
	}

	private handleMessage(message: unknown): void {
		if (!message || typeof message !== "object") return;
		const wire = message as WireMessage;
		if (wire.type === "response" && typeof wire.id === "string") {
			const pending = this.pending.get(wire.id);
			if (!pending) return;
			this.pending.delete(wire.id);
			clearTimeout(pending.timer);
			if (wire.success) pending.resolve(wire.data);
			else {
				const error = typeof wire.error === "string" ? wire.error : "Agents supervisor request failed";
				pending.reject(new Error(error));
			}
			return;
		}

		if (wire.type === "event") {
			for (const listener of this.listeners) {
				listener(wire as unknown as SupervisorEvent);
			}
		}
	}

	private handleDisconnect(socket: net.Socket, error: Error): void {
		if (this.socket !== socket) return;
		this.socket = undefined;
		this.protocolCurrent = false;
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}
	}

	async request<T = unknown>(
		type: string,
		payload: Record<string, unknown> = {},
		timeoutMs = REQUEST_TIMEOUT_MS,
	): Promise<T> {
		await this.connect(true);
		const socket = this.socket;
		if (!socket || socket.destroyed) throw new Error("Agents supervisor is unavailable");
		const id = `${process.pid}-${this.nextId++}`;

		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Agents supervisor request timed out: ${type}`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => resolve(value as T),
				reject,
				timer,
			});
			socket.write(`${JSON.stringify({ id, type, ...payload })}\n`, (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				this.pending.delete(id);
				clearTimeout(pending.timer);
				reject(error);
			});
		});
	}

	async list(): Promise<AgentRecord[]> {
		await this.ensureCurrentSupervisor();
		return this.request("list");
	}

	async dispatch(options: DispatchRequest): Promise<AgentRecord> {
		await this.ensureCurrentSupervisor();
		return this.request("dispatch", options as unknown as Record<string, unknown>, 180_000);
	}

	async prepareAttach(jobId: string): Promise<AgentRecord> {
		await this.ensureCurrentSupervisor();
		return this.request("prepare_attach", { jobId }, 180_000);
	}

	workerEvent(jobId: string, eventType: string, data: Record<string, unknown> = {}): Promise<AgentRecord> {
		return this.request("worker_event", {
			jobId,
			workerPid: process.pid,
			eventType,
			data,
		});
	}

	rename(jobId: string, name: string): Promise<AgentRecord> {
		return this.request("rename", { jobId, name });
	}

	pin(jobId: string, pinned: boolean): Promise<AgentRecord> {
		return this.request("pin", { jobId, pinned });
	}

	async setColor(jobId: string, color: AgentColor | undefined): Promise<AgentRecord> {
		const payload = { jobId, color: color ?? null };
		try {
			return await this.request("set_color", payload);
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("Unknown supervisor request: set_color")) {
				throw error;
			}
			await this.restartOutdatedSupervisor();
			return this.request("set_color", payload);
		}
	}

	reorder(jobId: string, direction: -1 | 1): Promise<AgentRecord[]> {
		return this.request("reorder", { jobId, direction });
	}

	stop(jobId: string): Promise<AgentRecord> {
		return this.request("stop", { jobId });
	}

	remove(jobId: string): Promise<void> {
		return this.request("remove", { jobId }, 180_000);
	}

	close(): void {
		this.closed = true;
		const error = new Error("Agents supervisor client closed");
		this.socket?.destroy();
		this.socket = undefined;
		this.protocolCurrent = false;
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(error);
			this.pending.delete(id);
		}
		this.listeners.clear();
	}
}

export const agentsRoot = ROOT;
export const agentsSocketPath = SOCKET_PATH;
