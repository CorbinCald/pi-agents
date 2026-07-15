import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("package registers GPT-5.6 Luna high-effort compaction", async () => {
	const manifest = JSON.parse(
		await readFile(new URL("package.json", root), "utf8"),
	);
	assert.ok(manifest.pi.extensions.includes("./compaction.ts"));

	const source = await readFile(new URL("compaction.ts", root), "utf8");
	assert.match(source, /const PROVIDER = "openai";/);
	assert.match(source, /const MODEL_ID = "gpt-5\.6-luna";/);
	assert.match(source, /const THINKING_LEVEL = "high" as const;/);
	assert.match(source, /pi\.on\("session_before_compact"/);
});
