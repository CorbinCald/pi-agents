import { execFile } from "node:child_process";
import {
	CustomEditor,
	copyToClipboard,
	DynamicBorder,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import { SupervisorClient } from "./client.ts";
import { installAgentsNavigationEditor } from "./editor.ts";
import { installSinglePressExit } from "./exit.ts";
import type { AgentRecord, SupervisorEvent } from "./types.ts";

const JOB_ID = process.env.PI_AGENT_JOB_ID;
const TMUX_SERVER = process.env.PI_AGENTS_TMUX_SERVER;
const CONTEXT_WIDGET = "agents-context";
const RECAP_WIDGET = "agents-recap";
const STATUS_KEY = "agents-worker";

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				part?.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function shortPath(path: string): string {
	const home = process.env.HOME;
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

async function copyLastAgentMessage(ctx: ExtensionContext): Promise<void> {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}
		const text = messageText(entry.message.content);
		if (!text) continue;
		try {
			await copyToClipboard(text);
			ctx.ui.notify("Copied last agent message", "info");
		} catch (error) {
			ctx.ui.notify(
				error instanceof Error ? error.message : String(error),
				"error",
			);
		}
		return;
	}
	ctx.ui.notify("No agent messages to copy yet", "warning");
}

function contextComponent(job: AgentRecord) {
	return (_tui: unknown, theme: ExtensionContext["ui"]["theme"]) =>
		new Text(
			[
				`${theme.fg("dim", "directory:")} ${shortPath(job.originalCwd)}`,
				`${theme.fg("dim", "worktree:")} ${job.worktreePath ? shortPath(job.worktreePath) : "not isolated"}`,
			].join("\n"),
			1,
			0,
		);
}

function detachClient(): void {
	if (!TMUX_SERVER) return;
	execFile(
		"tmux",
		[
			"-L",
			TMUX_SERVER,
			"detach-client",
			"-s",
			process.env.PI_AGENTS_TMUX_SESSION || "",
		],
		() => undefined,
	);
}

function recapComponent(job: AgentRecord) {
	return (_tui: unknown, theme: ExtensionContext["ui"]["theme"]) => {
		const container = new Container();
		container.addChild(
			new DynamicBorder((text: string) => theme.fg("accent", text)),
		);
		container.addChild(
			new Text(
				`${theme.bold(theme.fg("accent", "Agent recap"))}\n${job.recap || job.summary}`,
				1,
				0,
			),
		);
		container.addChild(
			new DynamicBorder((text: string) => theme.fg("accent", text)),
		);
		return container;
	};
}

export function registerWorkerIntegration(pi: ExtensionAPI): void {
	if (!JOB_ID) return;

	let client: SupervisorClient | undefined;
	let context: ExtensionContext | undefined;
	let unsubscribe: (() => void) | undefined;
	let unsubscribeExit: (() => void) | undefined;
	let reconnectTimer: ReturnType<typeof setInterval> | undefined;
	let applyingName = false;

	const getClient = () => {
		client ??= new SupervisorClient();
		return client;
	};

	const applyJobState = (job: AgentRecord) => {
		const ctx = context;
		if (!ctx || job.id !== JOB_ID) return;

		const color =
			job.status === "needs_input"
				? "warning"
				: job.status === "working"
					? "accent"
					: job.failed
						? "error"
						: "success";
		ctx.ui.setStatus(
			STATUS_KEY,
			ctx.ui.theme.fg(
				color,
				`Agents · ${job.status.replace("_", " ")} · ← or /agents to detach`,
			),
		);
		ctx.ui.setWidget(CONTEXT_WIDGET, contextComponent(job), {
			placement: "aboveEditor",
		});

		if (job.status === "complete" && job.recap) {
			ctx.ui.setWidget(RECAP_WIDGET, recapComponent(job), {
				placement: "aboveEditor",
			});
		} else {
			ctx.ui.setWidget(RECAP_WIDGET, undefined);
		}

		if (job.name && pi.getSessionName() !== job.name) {
			applyingName = true;
			try {
				pi.setSessionName(job.name);
			} finally {
				applyingName = false;
			}
		}
	};

	const sendEvent = async (
		eventType: string,
		data: Record<string, unknown> = {},
	) => {
		try {
			const job = await getClient().workerEvent(JOB_ID, eventType, data);
			applyJobState(job);
		} catch {
			// The native Pi session remains usable if the supervisor is restarting.
		}
	};

	const handleSupervisorEvent = (event: SupervisorEvent) => {
		if (event.event === "state" && event.job?.id === JOB_ID) {
			applyJobState(event.job);
		}
	};

	pi.registerShortcut("alt+c", {
		description: "Copy the last agent message",
		handler: copyLastAgentMessage,
	});

	pi.registerCommand("agents", {
		description: "Detach to the background Agents workspace",
		handler: async () => detachClient(),
	});

	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		unsubscribeExit?.();
		unsubscribeExit = installSinglePressExit(ctx, matchesKey);
		installAgentsNavigationEditor(
			ctx,
			(tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings),
			() => detachClient(),
		);

		const monitor = getClient();
		unsubscribe = monitor.onEvent(handleSupervisorEvent);
		reconnectTimer = setInterval(() => {
			void monitor.connect(false).catch(() => undefined);
		}, 2_000);
		reconnectTimer.unref?.();
		try {
			await monitor.connect(false);
			await sendEvent("session_start", {
				sessionFile: ctx.sessionManager.getSessionFile(),
				sessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				model: ctx.model
					? { provider: ctx.model.provider, id: ctx.model.id }
					: undefined,
				thinkingLevel: pi.getThinkingLevel(),
				name: pi.getSessionName(),
			});
		} catch {
			ctx.ui.setStatus(
				STATUS_KEY,
				ctx.ui.theme.fg(
					"warning",
					"Agents · supervisor reconnecting · ← detach",
				),
			);
		}
	});

	pi.on("agent_start", async () => {
		context?.ui.setWidget(RECAP_WIDGET, undefined);
		await sendEvent("agent_start");
	});

	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		await sendEvent("message_end", {
			text: messageText(event.message.content),
			stopReason: event.message.stopReason,
			errorMessage: event.message.errorMessage,
		});
	});

	pi.on("tool_execution_start", async (event) => {
		await sendEvent("tool_execution_start", {
			toolName: event.toolName,
			args: event.args,
		});
	});

	pi.on("agent_settled", async () => {
		await sendEvent("agent_settled");
	});

	pi.on("model_select", async (event) => {
		await sendEvent("model_select", {
			model: { provider: event.model.provider, id: event.model.id },
		});
	});

	pi.on("thinking_level_select", async (event) => {
		await sendEvent("thinking_level_select", { level: event.level });
	});

	pi.on("session_info_changed", async (event) => {
		if (applyingName) return;
		await sendEvent("session_info_changed", { name: event.name });
	});

	pi.on("session_shutdown", async (event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(CONTEXT_WIDGET, undefined);
		ctx.ui.setWidget(RECAP_WIDGET, undefined);
		if (event.reason === "quit")
			await sendEvent("session_shutdown", { reason: event.reason });
		unsubscribe?.();
		unsubscribe = undefined;
		unsubscribeExit?.();
		unsubscribeExit = undefined;
		if (reconnectTimer) clearInterval(reconnectTimer);
		reconnectTimer = undefined;
		client?.close();
		client = undefined;
		context = undefined;
	});
}
