import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SupervisorClient } from "./client.ts";
import { installAgentsNavigationEditor } from "./editor.ts";
import { attachAgentTerminal } from "./terminal.ts";
import type { AgentRecord, SupervisorEvent } from "./types.ts";
import { showAgentView } from "./ui.ts";
import { registerWorkerIntegration } from "./worker.ts";

const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export default function agentsExtension(pi: ExtensionAPI): void {
	if (process.env.PI_AGENTS_RECAP === "1") return;
	if (process.env.PI_AGENTS_WORKER === "1") {
		registerWorkerIntegration(pi);
		return;
	}

	let client: SupervisorClient | undefined;
	let activeContext: ExtensionContext | undefined;
	let viewOpen = false;
	let unsubscribeMonitor: (() => void) | undefined;
	const knownJobs = new Map<string, AgentRecord>();
	const previousStatuses = new Map<string, string>();

	const getClient = () => {
		if (!client) {
			client = new SupervisorClient();
			unsubscribeMonitor = client.onEvent(handleMonitorEvent);
		}
		return client;
	};

	const updateStatus = () => {
		const context = activeContext;
		if (!context) return;
		const needsInput = [...knownJobs.values()].filter(
			(job) => job.status === "needs_input",
		).length;
		const working = [...knownJobs.values()].filter(
			(job) => job.status === "working",
		).length;
		if (needsInput > 0) {
			context.ui.setStatus(
				"agents",
				context.ui.theme.fg(
					"warning",
					`${needsInput} agent${needsInput === 1 ? "" : "s"} need input`,
				),
			);
		} else if (working > 0) {
			context.ui.setStatus(
				"agents",
				context.ui.theme.fg(
					"accent",
					`${working} agent${working === 1 ? "" : "s"} working`,
				),
			);
		} else {
			context.ui.setStatus("agents", undefined);
		}
	};

	function handleMonitorEvent(event: SupervisorEvent): void {
		const context = activeContext;
		if (event.event === "removed" && event.jobId) {
			knownJobs.delete(event.jobId);
			previousStatuses.delete(event.jobId);
			updateStatus();
			return;
		}
		if (event.event !== "state" || !event.job) return;
		const previous = previousStatuses.get(event.job.id);
		knownJobs.set(event.job.id, event.job);
		if (!event.job.recapPending) {
			previousStatuses.set(event.job.id, event.job.status);
		}
		updateStatus();
		if (
			!context ||
			viewOpen ||
			!previous ||
			previous === event.job.status ||
			event.job.recapPending
		) {
			return;
		}
		if (event.job.status === "needs_input") {
			context.ui.notify(
				`${event.job.name}: ${event.job.waitingFor || event.job.summary}`,
				"warning",
			);
		} else if (event.job.status === "complete") {
			context.ui.notify(
				`${event.job.name}: ${event.job.summary}`,
				event.job.failed ? "error" : "info",
			);
		}
	}

	const cycleThinkingLevel = () => {
		const current = pi.getThinkingLevel();
		const currentIndex = Math.max(0, THINKING_LEVELS.indexOf(current));
		for (let offset = 1; offset <= THINKING_LEVELS.length; offset++) {
			const candidate =
				THINKING_LEVELS[(currentIndex + offset) % THINKING_LEVELS.length];
			if (!candidate) continue;
			pi.setThinkingLevel(candidate);
			const selected = pi.getThinkingLevel();
			if (selected !== current) return selected;
		}
		return current;
	};

	const open = async (context: ExtensionContext) => {
		if (viewOpen) return;
		if (context.mode !== "tui") {
			context.ui.notify("Agents requires interactive mode", "error");
			return;
		}
		if (!context.model) {
			context.ui.notify("Select a model before dispatching an agent", "error");
			return;
		}
		viewOpen = true;
		try {
			await showAgentView(context, getClient(), {
				cwd: context.cwd,
				model: {
					provider: context.model.provider,
					id: context.model.id,
				},
				getThinkingLevel: () => pi.getThinkingLevel(),
				cycleThinkingLevel,
				projectTrusted: context.isProjectTrusted(),
				attach: (tui, jobId) => attachAgentTerminal(tui, getClient(), jobId),
			});
		} catch (error) {
			context.ui.notify(
				error instanceof Error ? error.message : String(error),
				"error",
			);
		} finally {
			viewOpen = false;
		}
	};

	pi.registerCommand("agents", {
		description: "Open the background Agents workspace",
		handler: async (_args, context) => open(context),
	});

	pi.on("session_start", async (_event, context) => {
		activeContext = context;
		installAgentsNavigationEditor(
			context,
			(tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings),
			(editor) => editor.submitCommand("/agents"),
		);

		const monitor = getClient();
		if (!(await monitor.connectIfRunning())) return;
		try {
			for (const job of await monitor.list()) {
				knownJobs.set(job.id, job);
				previousStatuses.set(job.id, job.status);
			}
			updateStatus();
		} catch {
			// A stale socket is harmless; opening Agents restarts the supervisor.
		}
	});

	pi.on("session_shutdown", (_event, context) => {
		context.ui.setStatus("agents", undefined);
		activeContext = undefined;
		unsubscribeMonitor?.();
		unsubscribeMonitor = undefined;
		client?.close();
		client = undefined;
		knownJobs.clear();
		previousStatuses.clear();
	});
}
