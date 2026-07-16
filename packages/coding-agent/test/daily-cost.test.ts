import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DailyCostTracker, recordAssistantCost, seedDailyCostLedger } from "../src/core/daily-cost.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { alignDailyCostFooter } from "../src/modes/interactive/agents/ui.ts";

function assistantMessage(cost: number, timestamp: number, suffix: string = ""): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `response${suffix}` }],
		api: "cost-test",
		provider: "cost-provider",
		model: "cost-model",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop",
		timestamp,
	};
}

describe("daily cost tracking", () => {
	let tempDir: string;
	let ledgerPath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-daily-cost-"));
		ledgerPath = join(tempDir, "costs.jsonl");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("sums unique live costs since local midnight", () => {
		const now = new Date(2026, 6, 15, 12, 0, 0).getTime();
		const beforeMidnight = new Date(2026, 6, 14, 23, 59, 59).getTime();
		const afterNow = new Date(2026, 6, 15, 12, 0, 1).getTime();
		const currentMessage = assistantMessage(0.4, now - 1_000);

		recordAssistantCost(ledgerPath, assistantMessage(2, beforeMidnight), beforeMidnight);
		recordAssistantCost(ledgerPath, currentMessage, now - 500);
		recordAssistantCost(ledgerPath, currentMessage, now - 400);
		recordAssistantCost(ledgerPath, assistantMessage(0.8, afterNow), afterNow);

		const tracker = new DailyCostTracker(ledgerPath, 0);
		expect(tracker.getTotal(now)).toBeCloseTo(0.4);

		recordAssistantCost(ledgerPath, assistantMessage(0.2, now - 200), now - 100);
		expect(tracker.getTotal(now)).toBeCloseTo(0.6);
	});

	it("backfills today's transcripts once and deduplicates forked messages", async () => {
		const now = new Date(2026, 6, 15, 12, 0, 0).getTime();
		const midnight = new Date(2026, 6, 15, 0, 0, 0).getTime();
		const sessionsRoot = join(tempDir, "sessions");
		const firstDirectory = join(sessionsRoot, "--first--");
		const secondDirectory = join(sessionsRoot, "--fork--");
		mkdirSync(firstDirectory, { recursive: true });
		mkdirSync(secondDirectory, { recursive: true });

		const current = assistantMessage(0.75, now - 2_000);
		const old = assistantMessage(4, midnight - 2_000);
		const entries = [
			{
				type: "session",
				version: 3,
				id: "original",
				timestamp: new Date(midnight - 10_000).toISOString(),
				cwd: tempDir,
			},
			{
				type: "message",
				id: "old",
				parentId: null,
				timestamp: new Date(midnight - 1_000).toISOString(),
				message: old,
			},
			{
				type: "message",
				id: "current",
				parentId: "old",
				timestamp: new Date(now - 1_000).toISOString(),
				message: current,
			},
		];
		const contents = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		writeFileSync(join(firstDirectory, "original.jsonl"), contents);
		writeFileSync(join(secondDirectory, "fork.jsonl"), contents.replace('"id":"original"', '"id":"fork"'));

		await seedDailyCostLedger(ledgerPath, sessionsRoot, now);
		await seedDailyCostLedger(ledgerPath, sessionsRoot, now);

		const tracker = new DailyCostTracker(ledgerPath, 0);
		expect(tracker.getTotal(now)).toBeCloseTo(0.75);
		const records = readFileSync(ledgerPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string });
		expect(records.filter((record) => record.type === "cost")).toHaveLength(1);
		expect(records.filter((record) => record.type === "daily-seed")).toHaveLength(1);
	});

	it("records ModelRuntime calls, including calls without a persisted session", async () => {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath: null,
			costLedgerPath: ledgerPath,
			allowModelNetwork: false,
		});
		const api: Api = "cost-test";
		runtime.registerProvider("cost-provider", {
			api,
			apiKey: "test-key",
			baseUrl: "https://cost.invalid",
			models: [
				{
					id: "cost-model",
					name: "Cost Model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 100_000,
					maxTokens: 4_096,
				},
			],
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				stream.end(assistantMessage(1.25, Date.now()));
				return stream;
			},
		});
		const model = runtime.getModel("cost-provider", "cost-model") as Model<Api> | undefined;
		expect(model).toBeDefined();

		await runtime.completeSimple(model!, { messages: [] });

		const tracker = new DailyCostTracker(ledgerPath, 0);
		expect(tracker.getTotal()).toBeCloseTo(1.25);
	});

	it("keeps the Agents help and daily total within the footer width", () => {
		const line = alignDailyCostFooter(" Enter dispatch/open native Pi · ? help", 1.234, 48);
		expect(visibleWidth(line)).toBe(48);
		expect(line).toMatch(/Today \$1\.234$/);
		expect(visibleWidth(alignDailyCostFooter("help", 123.456, 8))).toBeLessThanOrEqual(8);
	});
});
