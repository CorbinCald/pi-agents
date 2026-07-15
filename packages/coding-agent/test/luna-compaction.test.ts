import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import type { compact } from "../src/core/compaction/index.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
	SessionCompactEvent,
} from "../src/core/extensions/index.ts";
import {
	createLunaCompactionExtension,
	LUNA_COMPACTION_MODEL_ID,
	LUNA_COMPACTION_PROVIDER,
	LUNA_COMPACTION_STATUS_ENTRY_TYPE,
	LUNA_COMPACTION_THINKING_LEVEL,
} from "../src/core/extensions/luna-compaction.ts";

describe("Luna compaction extension", () => {
	it("is registered by the shared Agent session services path", async () => {
		const tempDir = await mkdtemp(join(tmpdir(), "pi-luna-compaction-"));
		try {
			const services = await createAgentSessionServices({
				cwd: tempDir,
				agentDir: tempDir,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			const extension = services.resourceLoader
				.getExtensions()
				.extensions.find((candidate) => candidate.path === "<inline:luna-compaction>");

			expect(extension).toBeDefined();
			expect(extension?.handlers.get("session_before_compact")).toHaveLength(1);
			expect(extension?.handlers.get("session_compact")).toHaveLength(1);
			expect(extension?.entryRenderers?.has(LUNA_COMPACTION_STATUS_ENTRY_TYPE)).toBe(true);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it("compacts with GPT-5.6 Luna at high reasoning effort", async () => {
		const compaction = {
			summary: "summary",
			firstKeptEntryId: "kept-entry",
			tokensBefore: 100,
		};
		const compactSession = vi.fn(async () => compaction);
		type BeforeCompactHandler = ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>;
		type CompactHandler = ExtensionHandler<SessionCompactEvent>;
		const handlers = new Map<string, BeforeCompactHandler | CompactHandler>();
		const appendEntry = vi.fn();
		const registerEntryRenderer = vi.fn();
		const pi = {
			on(event: string, registeredHandler: BeforeCompactHandler | CompactHandler) {
				handlers.set(event, registeredHandler);
			},
			appendEntry,
			registerEntryRenderer,
		} as unknown as ExtensionAPI;

		await createLunaCompactionExtension(compactSession as unknown as typeof compact)(pi);
		const beforeCompactHandler = handlers.get("session_before_compact") as BeforeCompactHandler | undefined;
		const compactHandler = handlers.get("session_compact") as CompactHandler | undefined;
		expect(beforeCompactHandler).toBeDefined();
		expect(compactHandler).toBeDefined();
		expect(registerEntryRenderer).toHaveBeenCalledWith(LUNA_COMPACTION_STATUS_ENTRY_TYPE, expect.any(Function));

		const model = { provider: LUNA_COMPACTION_PROVIDER, id: LUNA_COMPACTION_MODEL_ID, name: "GPT-5.6 Luna" };
		const signal = new AbortController().signal;
		const preparation = { firstKeptEntryId: "kept-entry" };
		const notify = vi.fn();
		const context = {
			modelRegistry: {
				find: vi.fn(() => model),
				getApiKeyAndHeaders: vi.fn(async () => ({
					ok: true,
					apiKey: "key",
					headers: { "x-test": "value" },
					env: { TEST_ENV: "value" },
				})),
			},
			ui: { notify },
		} as unknown as ExtensionContext;
		const result = await beforeCompactHandler!(
			{
				preparation,
				customInstructions: "focus",
				signal,
			} as unknown as SessionBeforeCompactEvent,
			context,
		);

		expect(compactSession).toHaveBeenCalledWith(
			preparation,
			model,
			"key",
			{ "x-test": "value" },
			"focus",
			signal,
			LUNA_COMPACTION_THINKING_LEVEL,
			undefined,
			{ TEST_ENV: "value" },
		);
		expect(LUNA_COMPACTION_THINKING_LEVEL).toBe("high");
		expect(notify).toHaveBeenNthCalledWith(1, "Compacting with GPT-5.6 Luna at high effort", "info");
		expect(notify).toHaveBeenNthCalledWith(2, "Compacted with GPT-5.6 Luna at high effort", "info");
		expect(result).toEqual({ compaction });

		const compactEvent = { fromExtension: true } as SessionCompactEvent;
		await compactHandler!(compactEvent, context);
		await compactHandler!(compactEvent, context);
		expect(appendEntry).toHaveBeenCalledTimes(1);
		expect(appendEntry).toHaveBeenCalledWith(LUNA_COMPACTION_STATUS_ENTRY_TYPE, {
			message: "Compacted with GPT-5.6 Luna at high effort",
		});
	});
});
