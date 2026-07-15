import { Text } from "@earendil-works/pi-tui";
import { compact } from "../compaction/index.ts";
import type { ExtensionFactory } from "./types.ts";

export const LUNA_COMPACTION_PROVIDER = "openai";
export const LUNA_COMPACTION_MODEL_ID = "gpt-5.6-luna";
export const LUNA_COMPACTION_THINKING_LEVEL = "high" as const;
export const LUNA_COMPACTION_STATUS_ENTRY_TYPE = "luna-compaction-status";

interface LunaCompactionStatusEntry {
	message: string;
}

export function createLunaCompactionExtension(compactSession: typeof compact = compact): ExtensionFactory {
	return (pi) => {
		let completedMessage: string | undefined;

		pi.registerEntryRenderer<LunaCompactionStatusEntry>(
			LUNA_COMPACTION_STATUS_ENTRY_TYPE,
			(entry, _options, theme) => {
				const message = entry.data?.message ?? "Compacted with GPT-5.6 Luna at high effort";
				return new Text(`${theme.fg("success", "✓")} ${message}`, 0, 0);
			},
		);

		pi.on("session_before_compact", async (event, ctx) => {
			completedMessage = undefined;
			const model = ctx.modelRegistry.find(LUNA_COMPACTION_PROVIDER, LUNA_COMPACTION_MODEL_ID);
			if (!model) {
				ctx.ui.notify(
					`Compaction cancelled: ${LUNA_COMPACTION_PROVIDER}/${LUNA_COMPACTION_MODEL_ID} is unavailable`,
					"error",
				);
				return { cancel: true };
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				const reason = auth.ok ? "no API key is configured" : auth.error;
				ctx.ui.notify(`Compaction cancelled: ${reason}`, "error");
				return { cancel: true };
			}

			ctx.ui.notify(`Compacting with ${model.name} at ${LUNA_COMPACTION_THINKING_LEVEL} effort`, "info");

			try {
				const result = await compactSession(
					event.preparation,
					model,
					auth.apiKey,
					auth.headers,
					event.customInstructions,
					event.signal,
					LUNA_COMPACTION_THINKING_LEVEL,
					undefined,
					auth.env,
				);

				completedMessage = `Compacted with ${model.name} at ${LUNA_COMPACTION_THINKING_LEVEL} effort`;
				ctx.ui.notify(completedMessage, "info");
				return { compaction: result };
			} catch (error) {
				if (!event.signal.aborted) {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Compaction with ${model.name} failed: ${message}`, "error");
				}
				return { cancel: true };
			}
		});

		pi.on("session_compact", (event) => {
			const message = completedMessage;
			completedMessage = undefined;
			if (!event.fromExtension || !message) return;

			pi.appendEntry<LunaCompactionStatusEntry>(LUNA_COMPACTION_STATUS_ENTRY_TYPE, { message });
		});
	};
}

export const lunaCompactionExtension = createLunaCompactionExtension();
