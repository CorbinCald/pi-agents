import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";

function messageText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function compactText(value, max) {
	const text = String(value || "")
		.replace(/\s+/g, " ")
		.trim();
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

function activeBranch(entries) {
	const branchEntries = entries.filter(
		(entry) =>
			entry &&
			entry.type !== "session" &&
			typeof entry.id === "string" &&
			(entry.parentId === null || typeof entry.parentId === "string"),
	);
	const byId = new Map(branchEntries.map((entry) => [entry.id, entry]));
	const branch = [];
	const seen = new Set();
	let current = branchEntries.at(-1);
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		branch.push(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return branch.reverse();
}

export function canonicalSessionDirectory(sessionRoot, cwd) {
	const resolvedCwd = resolve(cwd);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(sessionRoot, safePath);
}

export function listNativeSessionFiles(sessionRoot) {
	if (!existsSync(sessionRoot)) return [];
	const files = [];
	for (const entry of readdirSync(sessionRoot, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(join(sessionRoot, entry.name));
			continue;
		}
		if (!entry.isDirectory()) continue;
		const directory = join(sessionRoot, entry.name);
		for (const child of readdirSync(directory, { withFileTypes: true })) {
			if (child.isFile() && child.name.endsWith(".jsonl")) {
				files.push(join(directory, child.name));
			}
		}
	}
	return files;
}

export function readNativeSession(filePath) {
	try {
		const entries = readFileSync(filePath, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		const header = entries[0];
		if (header?.type !== "session" || typeof header.id !== "string") {
			return undefined;
		}
		const cwd =
			typeof header.cwd === "string" && header.cwd
				? resolve(header.cwd)
				: process.cwd();

		const branch = activeBranch(entries);
		let name;
		let firstUserMessage = "";
		let lastAssistantMessage = "";
		let model;
		let thinkingLevel = "off";
		for (const entry of branch) {
			if (entry.type === "session_info") {
				name =
					typeof entry.name === "string" && entry.name.trim()
						? entry.name.trim()
						: undefined;
			} else if (entry.type === "model_change") {
				if (
					typeof entry.provider === "string" &&
					typeof entry.modelId === "string"
				) {
					model = { provider: entry.provider, id: entry.modelId };
				}
			} else if (
				entry.type === "thinking_level_change" &&
				typeof entry.thinkingLevel === "string"
			) {
				thinkingLevel = entry.thinkingLevel;
			} else if (entry.type === "message") {
				const message = entry.message;
				if (message?.role === "user" && !firstUserMessage) {
					firstUserMessage = messageText(message.content).trim();
				} else if (message?.role === "assistant") {
					lastAssistantMessage = messageText(message.content).trim();
					if (
						typeof message.provider === "string" &&
						typeof message.model === "string"
					) {
						model = { provider: message.provider, id: message.model };
					}
				}
			}
		}

		const stats = statSync(filePath);
		const createdAt = Date.parse(header.timestamp);
		const fallbackName =
			compactText(firstUserMessage, 48) || basename(cwd) || "Native Pi session";
		const summary =
			compactText(
				lastAssistantMessage.split("\n").filter(Boolean).at(-1),
				96,
			) ||
			compactText(firstUserMessage, 96) ||
			"Native Pi session";
		return {
			path: resolve(filePath),
			id: header.id,
			cwd,
			name: name || fallbackName,
			prompt: firstUserMessage,
			summary,
			model,
			thinkingLevel,
			createdAt: Number.isFinite(createdAt) ? createdAt : stats.birthtimeMs,
			updatedAt: stats.mtimeMs,
			leafId: branch.at(-1)?.id ?? null,
		};
	} catch {
		return undefined;
	}
}

function collisionPath(targetPath, sourcePath) {
	const extension = extname(targetPath);
	const stem = targetPath.slice(0, -extension.length);
	const fingerprint = createHash("sha256")
		.update(readFileSync(sourcePath))
		.digest("hex")
		.slice(0, 10);
	let candidate = `${stem}.legacy-${fingerprint}${extension}`;
	let index = 2;
	while (
		existsSync(candidate) &&
		!readFileSync(candidate).equals(readFileSync(sourcePath))
	) {
		candidate = `${stem}.legacy-${fingerprint}-${index}${extension}`;
		index++;
	}
	return candidate;
}

export function migrateLegacySessionFiles(legacyDirectory, sessionRoot) {
	const migrated = new Map();
	if (!existsSync(legacyDirectory)) return migrated;
	for (const entry of readdirSync(legacyDirectory, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const sourcePath = resolve(legacyDirectory, entry.name);
		const session = readNativeSession(sourcePath);
		if (!session) continue;
		const targetDirectory = canonicalSessionDirectory(sessionRoot, session.cwd);
		mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
		let targetPath = join(targetDirectory, entry.name);
		if (existsSync(targetPath)) {
			if (readFileSync(targetPath).equals(readFileSync(sourcePath))) {
				unlinkSync(sourcePath);
				migrated.set(sourcePath, resolve(targetPath));
				continue;
			}
			targetPath = collisionPath(targetPath, sourcePath);
			if (existsSync(targetPath)) {
				unlinkSync(sourcePath);
				migrated.set(sourcePath, resolve(targetPath));
				continue;
			}
		}
		try {
			renameSync(sourcePath, targetPath);
		} catch (error) {
			if (error?.code !== "EXDEV") throw error;
			copyFileSync(sourcePath, targetPath);
			unlinkSync(sourcePath);
		}
		migrated.set(sourcePath, resolve(targetPath));
	}
	return migrated;
}

export function appendNativeSessionName(filePath, name) {
	const session = readNativeSession(filePath);
	if (!session)
		throw new Error(`Cannot rename invalid Pi session: ${filePath}`);
	const entry = {
		type: "session_info",
		id: randomUUID().slice(0, 8),
		parentId: session.leafId,
		timestamp: new Date().toISOString(),
		name,
	};
	appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}
