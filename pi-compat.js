import {
	existsSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const SUPPORTED_PI_VERSION = "0.80.6";
const INTERACTIVE_MODE_PATH = join(
	"dist",
	"modes",
	"interactive",
	"interactive-mode.js",
);
const COMPACTION_MESSAGE_IMPORT =
	'import { createCompactionSummaryMessage } from "../../core/messages.js";\n';
const REDUNDANT_COMPACTION_APPEND =
	"                    this.addMessageToChat(createCompactionSummaryMessage(event.result.summary, event.result.tokensBefore, new Date().toISOString()));\n";
const PATCHED_COMPACTION_RENDER =
	"                    this.rebuildChatFromMessages();\n                    this.footer.invalidate();\n";

function occurrences(source, value) {
	return source.split(value).length - 1;
}

function packageRootFromPath(candidate) {
	if (!candidate || !existsSync(candidate)) return undefined;

	let current;
	try {
		const canonical = realpathSync(candidate);
		current = statSync(canonical).isDirectory()
			? canonical
			: dirname(canonical);
	} catch {
		return undefined;
	}

	while (true) {
		const manifestPath = join(current, "package.json");
		if (existsSync(manifestPath)) {
			try {
				const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
				if (manifest.name === PI_PACKAGE_NAME) return current;
			} catch {
				// Keep walking; this may be an unrelated malformed manifest.
			}
		}
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function invocationPaths(invocation, environment) {
	const candidates = [];
	for (const argument of invocation?.argsPrefix || []) {
		if (typeof argument !== "string" || argument.startsWith("-")) continue;
		candidates.push(isAbsolute(argument) ? argument : resolve(argument));
	}

	const command = invocation?.command;
	if (typeof command !== "string" || !command) return candidates;
	if (isAbsolute(command) || command.includes("/")) {
		candidates.push(isAbsolute(command) ? command : resolve(command));
		return candidates;
	}
	for (const directory of String(environment.PATH || "").split(delimiter)) {
		if (directory) candidates.push(join(directory, command));
	}
	return candidates;
}

export function findPiPackageRoot(invocation, environment = process.env) {
	for (const candidate of invocationPaths(invocation, environment)) {
		const root = packageRootFromPath(candidate);
		if (root) return root;
	}
	return undefined;
}

export function ensurePiCompactionUiPatch(
	invocation,
	{ environment = process.env, packageRoot } = {},
) {
	const root = packageRoot || findPiPackageRoot(invocation, environment);
	if (!root) return { status: "not-applicable" };

	const manifestPath = join(root, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.name !== PI_PACKAGE_NAME) {
		throw new Error(`Refusing to patch unexpected package at ${root}`);
	}

	const targetPath = join(root, INTERACTIVE_MODE_PATH);
	if (!existsSync(targetPath)) {
		throw new Error(`Pi interactive mode was not found at ${targetPath}`);
	}
	const source = readFileSync(targetPath, "utf8");
	const importCount = occurrences(source, COMPACTION_MESSAGE_IMPORT);
	const appendCount = occurrences(source, REDUNDANT_COMPACTION_APPEND);

	if (importCount === 0 && appendCount === 0) {
		if (!source.includes(PATCHED_COMPACTION_RENDER)) {
			throw new Error(
				`Refusing to patch an unexpected Pi compaction UI layout at ${targetPath}`,
			);
		}
		return {
			status: "already-patched",
			packageRoot: root,
			version: manifest.version,
			targetPath,
		};
	}
	if (manifest.version !== SUPPORTED_PI_VERSION) {
		throw new Error(
			`Pi Agents supports the compaction UI patch for Pi ${SUPPORTED_PI_VERSION}; found ${manifest.version || "an unknown version"} at ${root}`,
		);
	}
	if (importCount !== 1 || appendCount !== 1) {
		throw new Error(
			`Refusing to patch an unexpected Pi compaction UI layout at ${targetPath}`,
		);
	}

	const patched = source
		.replace(COMPACTION_MESSAGE_IMPORT, "")
		.replace(REDUNDANT_COMPACTION_APPEND, "");
	const temporaryPath = `${targetPath}.pi-agents-${process.pid}.tmp`;
	try {
		writeFileSync(temporaryPath, patched, { mode: statSync(targetPath).mode });
		renameSync(temporaryPath, targetPath);
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}

	return {
		status: "patched",
		packageRoot: root,
		version: manifest.version,
		targetPath,
	};
}

export function ensureCurrentPiCompactionUiPatch() {
	return ensurePiCompactionUiPatch({
		command: process.execPath,
		argsPrefix: process.argv[1] ? [process.argv[1]] : [],
	});
}
