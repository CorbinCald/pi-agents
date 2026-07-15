import type { ExtensionAPI, ExtensionContext } from "../../../core/extensions/types.ts";
import { CustomEditor } from "../components/custom-editor.ts";
import { SupervisorClient } from "./client.ts";
import { installAgentsNavigationEditor } from "./editor.ts";
import { installSinglePressExit, requestSinglePressExit } from "./exit.ts";
import { DispatchReasoningController, supportsMaxProReasoning, withMaxProReasoning } from "./reasoning.ts";
import { attachAgentTerminal } from "./terminal.ts";
import type { AgentRecord, SupervisorEvent } from "./types.ts";
import { showAgentView } from "./ui.ts";
import { registerWorkerIntegration } from "./worker.ts";

const REASONING_STATUS_KEY = "agents-reasoning";

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
	let unsubscribeExit: (() => void) | undefined;
	const knownJobs = new Map<string, AgentRecord>();
	const previousStatuses = new Map<string, string>();
	const dispatchReasoning = new DispatchReasoningController(
		{
			getThinkingLevel: () => pi.getThinkingLevel(),
			setThinkingLevel: (level) => pi.setThinkingLevel(level),
		},
		() => activeContext?.model,
	);

	const updateReasoningStatus = () => {
		const context = activeContext;
		if (!context) return;
		const maxPro = dispatchReasoning.getSelection().reasoningMode === "pro";
		context.ui.setStatus(REASONING_STATUS_KEY, maxPro ? context.ui.theme.fg("accent", "Max Pro") : undefined);
	};

	const cycleNativeReasoning = () => {
		const selection = dispatchReasoning.cycleMaxProBoundary();
		if (!selection) return false;
		updateReasoningStatus();
		return true;
	};

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
		const needsInput = [...knownJobs.values()].filter((job) => job.status === "needs_input").length;
		const working = [...knownJobs.values()].filter((job) => job.status === "working").length;
		if (needsInput > 0) {
			context.ui.setStatus(
				"agents",
				context.ui.theme.fg("warning", `${needsInput} agent${needsInput === 1 ? "" : "s"} need input`),
			);
		} else if (working > 0) {
			context.ui.setStatus(
				"agents",
				context.ui.theme.fg("accent", `${working} agent${working === 1 ? "" : "s"} working`),
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
		if (!context || viewOpen || !previous || previous === event.job.status || event.job.recapPending) {
			return;
		}
		if (event.job.status === "needs_input") {
			context.ui.notify(`${event.job.name}: ${event.job.waitingFor || event.job.summary}`, "warning");
		} else if (event.job.status === "complete") {
			context.ui.notify(`${event.job.name}: ${event.job.summary}`, event.job.failed ? "error" : "info");
		}
	}

	const open = async (context: ExtensionContext, options: { standalone?: boolean } = {}) => {
		if (viewOpen) return;
		if (context.mode !== "tui") {
			context.ui.notify("Agents requires interactive mode", "error");
			return;
		}
		viewOpen = true;
		try {
			await showAgentView(context, getClient(), {
				cwd: context.cwd,
				model: context.model
					? {
							provider: context.model.provider,
							id: context.model.id,
						}
					: undefined,
				standalone: options.standalone,
				fullscreen: true,
				getReasoning: () => dispatchReasoning.getSelection(),
				cycleReasoning: () => {
					const selection = dispatchReasoning.cycle();
					updateReasoningStatus();
					return selection;
				},
				projectTrusted: context.isProjectTrusted(),
				exit: () => requestSinglePressExit(context),
				attach: (tui, jobId) => attachAgentTerminal(tui, getClient(), jobId),
			});
		} catch (error) {
			context.ui.notify(error instanceof Error ? error.message : String(error), "error");
		} finally {
			viewOpen = false;
			if (options.standalone) requestSinglePressExit(context);
		}
	};

	pi.registerCommand("agents", {
		description: "Open the background Agents workspace",
		handler: async (_args, context) => open(context),
	});

	pi.on("workspace_start", async (_event, context) => {
		await open(context, { standalone: true });
	});

	pi.on("before_provider_request", (event, context) => {
		if (dispatchReasoning.getSelection().reasoningMode !== "pro" || !supportsMaxProReasoning(context.model)) {
			return;
		}
		return withMaxProReasoning(event.payload);
	});

	pi.on("model_select", () => updateReasoningStatus());
	pi.on("thinking_level_select", () => updateReasoningStatus());

	pi.on("session_start", async (_event, context) => {
		activeContext = context;
		updateReasoningStatus();
		unsubscribeExit?.();
		installAgentsNavigationEditor(
			context,
			(tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings),
			(editor) => editor.submitCommand("/agents"),
			cycleNativeReasoning,
			undefined,
			(keybindings) => {
				unsubscribeExit?.();
				unsubscribeExit = installSinglePressExit(context, keybindings);
			},
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
		context.ui.setStatus(REASONING_STATUS_KEY, undefined);
		activeContext = undefined;
		unsubscribeMonitor?.();
		unsubscribeMonitor = undefined;
		unsubscribeExit?.();
		unsubscribeExit = undefined;
		client?.close();
		client = undefined;
		knownJobs.clear();
		previousStatuses.clear();
	});
}
