import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readSync,
	statSync,
} from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { AssistantMessage } from "@earendil-works/pi-ai";

interface DailyCostRecord {
	type: "cost";
	id: string;
	timestamp: number;
	provider: string;
	model: string;
	cost: number;
	source: "live" | "session";
}

interface DailyCostSeedRecord {
	type: "daily-seed";
	midnight: number;
	timestamp: number;
}

type LedgerRecord = DailyCostRecord | DailyCostSeedRecord;

type TrackedRecord = Pick<DailyCostRecord, "cost" | "source">;

function localMidnight(timestamp: number): number {
	const date = new Date(timestamp);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseLedgerRecord(line: string): LedgerRecord | undefined {
	try {
		const value = JSON.parse(line) as Partial<LedgerRecord>;
		if (
			value.type === "cost" &&
			typeof value.id === "string" &&
			finiteNumber(value.timestamp) &&
			typeof value.provider === "string" &&
			typeof value.model === "string" &&
			finiteNumber(value.cost) &&
			value.cost >= 0 &&
			(value.source === "live" || value.source === "session")
		) {
			return value as DailyCostRecord;
		}
		if (value.type === "daily-seed" && finiteNumber(value.midnight) && finiteNumber(value.timestamp)) {
			return value as DailyCostSeedRecord;
		}
	} catch {
		// Ignore malformed or partially written records.
	}
	return undefined;
}

function assistantCostRecord(
	message: AssistantMessage,
	timestamp: number,
	source: DailyCostRecord["source"],
): DailyCostRecord | undefined {
	const cost = message.usage?.cost?.total;
	if (!finiteNumber(cost) || cost <= 0) return undefined;

	const messageTimestamp = finiteNumber(message.timestamp) ? message.timestamp : timestamp;
	const usage = message.usage;
	const identity = JSON.stringify([
		messageTimestamp,
		message.api,
		message.provider,
		message.model,
		usage.input,
		usage.output,
		usage.cacheRead,
		usage.cacheWrite,
		usage.totalTokens,
		usage.cost.input,
		usage.cost.output,
		usage.cost.cacheRead,
		usage.cost.cacheWrite,
		usage.cost.total,
		message.stopReason,
	]);

	return {
		type: "cost",
		id: createHash("sha256").update(identity).digest("hex"),
		timestamp,
		provider: message.provider,
		model: message.model,
		cost,
		source,
	};
}

function appendLedgerLines(ledgerPath: string, lines: string[]): void {
	if (lines.length === 0) return;
	mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
	appendFileSync(ledgerPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

/** Record one completed LLM response without allowing accounting I/O to affect the request. */
export function recordAssistantCost(
	ledgerPath: string,
	message: AssistantMessage,
	timestamp: number = Date.now(),
): void {
	const record = assistantCostRecord(message, timestamp, "live");
	if (!record) return;
	try {
		appendLedgerLines(ledgerPath, [JSON.stringify(record)]);
	} catch {
		// Cost tracking is best-effort and must never fail an LLM request.
	}
}

async function listSessionFiles(root: string): Promise<string[]> {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const directories = [root];
	while (directories.length > 0) {
		const directory = directories.pop();
		if (!directory) break;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) directories.push(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		}
	}
	return files;
}

async function readSeedState(
	ledgerPath: string,
	midnight: number,
	now: number,
): Promise<{ seeded: boolean; ids: Set<string> }> {
	const ids = new Set<string>();
	let seeded = false;
	if (!existsSync(ledgerPath)) return { seeded, ids };

	const lines = createInterface({ input: createReadStream(ledgerPath), crlfDelay: Number.POSITIVE_INFINITY });
	for await (const line of lines) {
		const record = parseLedgerRecord(line);
		if (record?.type === "daily-seed" && record.midnight === midnight) seeded = true;
		if (record?.type === "cost" && record.timestamp >= midnight && record.timestamp <= now) ids.add(record.id);
	}
	return { seeded, ids };
}

/**
 * Backfill costs already persisted in today's transcripts. A marker makes this a
 * once-per-local-day scan; live ModelRuntime records cover subsequent requests.
 */
export async function seedDailyCostLedger(
	ledgerPath: string,
	sessionRoot: string,
	now: number = Date.now(),
): Promise<void> {
	const midnight = localMidnight(now);
	const state = await readSeedState(ledgerPath, midnight, now);
	if (state.seeded) return;

	for (const filePath of await listSessionFiles(sessionRoot)) {
		let modifiedAt: number;
		try {
			modifiedAt = (await stat(filePath)).mtimeMs;
		} catch {
			continue;
		}
		if (modifiedAt < midnight) continue;

		const pending: string[] = [];
		const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Number.POSITIVE_INFINITY });
		for await (const line of lines) {
			let entry: {
				type?: unknown;
				timestamp?: unknown;
				message?: Partial<AssistantMessage>;
			};
			try {
				entry = JSON.parse(line) as typeof entry;
			} catch {
				continue;
			}
			if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
			const entryTimestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
			const occurredAt = Number.isFinite(entryTimestamp)
				? entryTimestamp
				: finiteNumber(entry.message.timestamp)
					? entry.message.timestamp
					: Number.NaN;
			if (!Number.isFinite(occurredAt) || occurredAt < midnight || occurredAt > now) continue;
			const record = assistantCostRecord(entry.message as AssistantMessage, occurredAt, "session");
			if (!record || state.ids.has(record.id)) continue;
			state.ids.add(record.id);
			pending.push(JSON.stringify(record));
		}
		appendLedgerLines(ledgerPath, pending);
	}

	appendLedgerLines(ledgerPath, [
		JSON.stringify({ type: "daily-seed", midnight, timestamp: now } satisfies DailyCostSeedRecord),
	]);
}

/** Incremental reader used by footer components that render frequently. */
export class DailyCostTracker {
	private offset = 0;
	private total = 0;
	private midnight = Number.NaN;
	private nextRefreshAt = 0;
	private readonly records = new Map<string, TrackedRecord>();
	private readonly ledgerPath: string;
	private readonly refreshIntervalMs: number;

	constructor(ledgerPath: string, refreshIntervalMs: number = 1_000) {
		this.ledgerPath = ledgerPath;
		this.refreshIntervalMs = refreshIntervalMs;
	}

	getTotal(now: number = Date.now()): number {
		const currentMidnight = localMidnight(now);
		if (currentMidnight === this.midnight && now < this.nextRefreshAt) return this.total;
		this.nextRefreshAt = now + this.refreshIntervalMs;
		if (currentMidnight !== this.midnight) {
			this.midnight = currentMidnight;
			this.reset();
		}
		this.refresh(now);
		return this.total;
	}

	private reset(): void {
		this.offset = 0;
		this.total = 0;
		this.records.clear();
	}

	private refresh(now: number): void {
		let size: number;
		try {
			size = statSync(this.ledgerPath).size;
		} catch {
			if (this.offset > 0) this.reset();
			return;
		}
		if (size < this.offset) this.reset();
		if (size === this.offset) return;

		const length = size - this.offset;
		const buffer = Buffer.alloc(length);
		let bytesRead = 0;
		let fileDescriptor: number | undefined;
		try {
			fileDescriptor = openSync(this.ledgerPath, "r");
			while (bytesRead < length) {
				const read = readSync(fileDescriptor, buffer, bytesRead, length - bytesRead, this.offset + bytesRead);
				if (read === 0) break;
				bytesRead += read;
			}
		} catch {
			return;
		} finally {
			if (fileDescriptor !== undefined) closeSync(fileDescriptor);
		}

		const completeBuffer = buffer.subarray(0, bytesRead);
		const finalNewline = completeBuffer.lastIndexOf(0x0a);
		if (finalNewline < 0) return;
		this.offset += finalNewline + 1;
		for (const line of completeBuffer.subarray(0, finalNewline).toString("utf8").split("\n")) {
			const record = parseLedgerRecord(line);
			if (record?.type !== "cost" || record.timestamp < this.midnight || record.timestamp > now) {
				continue;
			}
			const previous = this.records.get(record.id);
			if (previous && (previous.source === "live" || record.source === "session")) continue;
			if (previous) this.total -= previous.cost;
			this.records.set(record.id, { cost: record.cost, source: record.source });
			this.total += record.cost;
		}
	}
}

export function formatDailyCost(cost: number): string {
	return `Today $${Math.max(0, cost).toFixed(3)}`;
}
