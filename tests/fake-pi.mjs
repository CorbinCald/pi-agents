#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);

function arg(name) {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function emit(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (args.includes("-p")) {
	let prompt = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => (prompt += chunk));
	process.stdin.on("end", () => {
		const lastQuestion = prompt.lastIndexOf("Which option should I use?");
		const lastCompleted = prompt.lastIndexOf("Completed isolated task");
		const needsInput = lastQuestion > lastCompleted;
		const result = {
			status: needsInput ? "needs_input" : "complete",
			title: needsInput ? "Choose Test Option" : "Finished Test Task",
			summary: needsInput
				? "Waiting for a test option"
				: "Finished the isolated test task",
			recap: needsInput
				? "The worker needs a test option."
				: "The worker completed its task in an isolated worktree.",
			question: needsInput ? "Which option should I use?" : "",
		};
		emit({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: JSON.stringify(result) }],
				stopReason: "stop",
			},
		});
	});
} else if (process.env.PI_AGENTS_WORKER === "1" && !args.includes("--mode")) {
	const sessionId = randomUUID();
	const sessionDir = arg("--session-dir");
	const openedSession = arg("--session");
	const sessionFile = openedSession || join(sessionDir, `${sessionId}.jsonl`);
	mkdirSync(dirname(sessionFile), { recursive: true });
	if (!existsSync(sessionFile)) {
		writeFileSync(
			sessionFile,
			`${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: process.cwd() })}\n`,
		);
	}
	let counter = readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter(Boolean).length;
	let parentId = counter > 1 ? counter.toString(16).padStart(8, "0") : null;
	const save = (message) => {
		counter += 1;
		const id = counter.toString(16).padStart(8, "0");
		appendFileSync(
			sessionFile,
			`${JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(), message })}\n`,
		);
		parentId = id;
	};

	const socket = net.createConnection(
		join(process.env.PI_AGENTS_ROOT, "supervisor.sock"),
	);
	let nextId = 1;
	let socketBuffer = "";
	const pending = new Map();
	socket.on("data", (chunk) => {
		socketBuffer += chunk.toString();
		while (true) {
			const newline = socketBuffer.indexOf("\n");
			if (newline < 0) break;
			const line = socketBuffer.slice(0, newline);
			socketBuffer = socketBuffer.slice(newline + 1);
			if (!line) continue;
			const response = JSON.parse(line);
			if (response.type !== "response") continue;
			const handler = pending.get(response.id);
			if (!handler) continue;
			pending.delete(response.id);
			if (response.success) handler.resolve(response.data);
			else handler.reject(new Error(response.error));
		}
	});
	const request = (eventType, data = {}) =>
		new Promise((resolve, reject) => {
			const id = `w-${nextId++}`;
			pending.set(id, { resolve, reject });
			socket.write(
				`${JSON.stringify({ id, type: "worker_event", jobId: process.env.PI_AGENT_JOB_ID, workerPid: process.pid, eventType, data })}\n`,
			);
		});

	const runPrompt = async (prompt) => {
		const user = {
			role: "user",
			content: [{ type: "text", text: prompt }],
			timestamp: Date.now(),
		};
		save(user);
		await request("agent_start");
		writeFileSync(
			join(process.cwd(), `agent-${process.env.PI_AGENT_JOB_ID}.txt`),
			prompt,
		);
		const fails = /\berror\b/i.test(prompt);
		const output =
			/\bask\b/i.test(prompt) || fails
				? "Which option should I use?"
				: `Completed isolated task in ${process.cwd()}.`;
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: output }],
			stopReason: fails ? "error" : "stop",
			...(fails ? { errorMessage: "Synthetic worker failure" } : {}),
			timestamp: Date.now(),
		};
		save(assistant);
		await request("message_end", {
			text: output,
			stopReason: assistant.stopReason,
			errorMessage: assistant.errorMessage,
		});
		await request("agent_settled");
	};

	socket.once("connect", async () => {
		await request("session_start", {
			sessionFile,
			sessionId,
			cwd: process.cwd(),
			model: { provider: "fake", id: "fake" },
			thinkingLevel: "medium",
		});
		const initialPrompt = args.at(-1);
		if (initialPrompt && !initialPrompt.startsWith("--")) {
			await runPrompt(initialPrompt);
		}
	});

	let input = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		input += chunk;
		const lines = input.split(/[\r\n]+/);
		input = lines.pop() || "";
		for (const line of lines) {
			const prompt = line.trim();
			if (!prompt) continue;
			if (prompt === "/quit") {
				void request("session_shutdown", { reason: "quit" }).finally(() =>
					process.exit(0),
				);
			} else {
				void runPrompt(prompt);
			}
		}
	});
}
