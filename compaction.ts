import { compact, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai";
const MODEL_ID = "gpt-5.6-luna";
const THINKING_LEVEL = "high" as const;

export default function registerLunaCompaction(pi: ExtensionAPI): void {
	pi.on("session_before_compact", async (event, ctx) => {
		const model = ctx.modelRegistry.find(PROVIDER, MODEL_ID);
		if (!model) {
			ctx.ui.notify(
				`Compaction cancelled: ${PROVIDER}/${MODEL_ID} is unavailable`,
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

		ctx.ui.notify(
			`Compacting with ${model.name} at ${THINKING_LEVEL} effort`,
			"info",
		);

		try {
			const result = await compact(
				event.preparation,
				model,
				auth.apiKey,
				auth.headers,
				event.customInstructions,
				event.signal,
				THINKING_LEVEL,
				undefined,
				auth.env,
			);

			return { compaction: result };
		} catch (error) {
			if (!event.signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`Compaction with ${model.name} failed: ${message}`,
					"error",
				);
			}
			return { cancel: true };
		}
	});
}
