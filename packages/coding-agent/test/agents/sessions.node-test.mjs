import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
	appendNativeSessionName,
	canonicalSessionDirectory,
	listNativeSessionFiles,
	migrateLegacySessionFiles,
	readNativeSession,
} from "../../src/modes/interactive/agents/sessions.mjs";

function sessionContents(id, cwd) {
	const entries = [
		{
			type: "session",
			version: 3,
			id,
			timestamp: "2026-07-01T00:00:00.000Z",
			cwd,
		},
		{
			type: "message",
			id: "user0001",
			parentId: null,
			timestamp: "2026-07-01T00:00:01.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: "Implement canonical sessions" }],
			},
		},
		{
			type: "message",
			id: "asst0001",
			parentId: "user0001",
			timestamp: "2026-07-01T00:00:02.000Z",
			message: {
				role: "assistant",
				provider: "openai",
				model: "gpt-5.6-sol",
				content: [{ type: "text", text: "Canonical sessions are ready." }],
			},
		},
	];
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

test("legacy agent transcripts migrate into Pi's canonical cwd namespace", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agents-sessions-"));
	const legacy = join(root, "agents", "sessions");
	const canonical = join(root, "sessions");
	const cwd = join(root, "workspace");
	mkdirSync(legacy, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	const source = join(legacy, "legacy.jsonl");
	writeFileSync(source, sessionContents("legacy-session", cwd));

	try {
		const migrated = migrateLegacySessionFiles(legacy, canonical);
		const target = migrated.get(source);
		assert.equal(
			target,
			join(canonicalSessionDirectory(canonical, cwd), basename(source)),
		);
		assert.equal(existsSync(source), false);
		assert.equal(existsSync(target), true);
		assert.deepEqual(listNativeSessionFiles(canonical), [target]);

		const session = readNativeSession(target);
		assert.equal(session.id, "legacy-session");
		assert.equal(session.name, "Implement canonical sessions");
		assert.equal(session.summary, "Canonical sessions are ready.");
		assert.deepEqual(session.model, { provider: "openai", id: "gpt-5.6-sol" });

		appendNativeSessionName(target, "Renamed everywhere");
		assert.equal(readNativeSession(target).name, "Renamed everywhere");
		assert.match(readFileSync(target, "utf8"), /"type":"session_info"/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("migration never overwrites a different canonical transcript", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agents-session-collision-"));
	const legacy = join(root, "agents", "sessions");
	const canonical = join(root, "sessions");
	const cwd = join(root, "workspace");
	const targetDirectory = canonicalSessionDirectory(canonical, cwd);
	mkdirSync(legacy, { recursive: true });
	mkdirSync(targetDirectory, { recursive: true });
	const source = join(legacy, "same-name.jsonl");
	const existing = join(targetDirectory, "same-name.jsonl");
	writeFileSync(source, sessionContents("legacy-session", cwd));
	writeFileSync(existing, sessionContents("canonical-session", cwd));

	try {
		const target = migrateLegacySessionFiles(legacy, canonical).get(source);
		assert.notEqual(target, existing);
		assert.equal(readNativeSession(existing).id, "canonical-session");
		assert.equal(readNativeSession(target).id, "legacy-session");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
