import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensurePiCompactionUiPatch, findPiPackageRoot } from "../pi-compat.js";

const importLine =
	'import { createCompactionSummaryMessage } from "../../core/messages.js";\n';
const appendLine =
	"                    this.addMessageToChat(createCompactionSummaryMessage(event.result.summary, event.result.tokensBefore, new Date().toISOString()));\n";
const unpatchedInteractiveMode = `${importLine}
export class InteractiveMode {
    handleCompactionEnd(event) {
                    this.chatContainer.clear();
                    this.rebuildChatFromMessages();
${appendLine}                    this.footer.invalidate();
    }
}
`;

function createPiFixture(
	version = "0.80.6",
	source = unpatchedInteractiveMode,
) {
	const root = mkdtempSync(join(tmpdir(), "pi-agents-pi-compat-"));
	const interactiveDirectory = join(root, "dist", "modes", "interactive");
	mkdirSync(interactiveDirectory, { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		`${JSON.stringify({ name: "@earendil-works/pi-coding-agent", version })}\n`,
	);
	writeFileSync(join(root, "dist", "cli.js"), "// fixture CLI\n");
	const targetPath = join(interactiveDirectory, "interactive-mode.js");
	writeFileSync(targetPath, source);
	return {
		root,
		targetPath,
		invocation: {
			command: process.execPath,
			argsPrefix: [join(root, "dist", "cli.js")],
		},
	};
}

function cleanup(fixture) {
	rmSync(fixture.root, { recursive: true, force: true });
}

test("Pi package discovery follows the managed CLI invocation", () => {
	const fixture = createPiFixture();
	try {
		assert.equal(findPiPackageRoot(fixture.invocation), fixture.root);
	} finally {
		cleanup(fixture);
	}
});

test("compaction UI patch removes the duplicate append and is idempotent", () => {
	const fixture = createPiFixture();
	try {
		const first = ensurePiCompactionUiPatch(fixture.invocation);
		assert.equal(first.status, "patched");
		const source = readFileSync(fixture.targetPath, "utf8");
		assert.equal(source.includes(importLine), false);
		assert.equal(source.includes(appendLine), false);
		assert.equal(source.includes("this.rebuildChatFromMessages();"), true);

		const second = ensurePiCompactionUiPatch(fixture.invocation);
		assert.equal(second.status, "already-patched");
		assert.equal(readFileSync(fixture.targetPath, "utf8"), source);
	} finally {
		cleanup(fixture);
	}
});

test("compaction UI patch rejects unsupported Pi versions before mutation", () => {
	const fixture = createPiFixture("0.80.7");
	try {
		assert.throws(
			() => ensurePiCompactionUiPatch(fixture.invocation),
			/supports the compaction UI patch for Pi 0\.80\.6/,
		);
		assert.equal(
			readFileSync(fixture.targetPath, "utf8"),
			unpatchedInteractiveMode,
		);
	} finally {
		cleanup(fixture);
	}
});

test("compaction UI patch rejects unexpected source layouts", () => {
	const fixture = createPiFixture(
		"0.80.6",
		"export class InteractiveMode {}\n",
	);
	try {
		assert.throws(
			() => ensurePiCompactionUiPatch(fixture.invocation),
			/unexpected Pi compaction UI layout/,
		);
	} finally {
		cleanup(fixture);
	}
});

test("non-Pi invocations are left untouched", () => {
	assert.deepEqual(
		ensurePiCompactionUiPatch({
			command: process.execPath,
			argsPrefix: [import.meta.filename],
		}),
		{ status: "not-applicable" },
	);
});
