import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SupervisorClient } from "../src/modes/interactive/agents/client.ts";
import { shouldExitAgentHost } from "../src/modes/interactive/agents/index.ts";
import type { AgentRecord, AgentStatus } from "../src/modes/interactive/agents/types.ts";
import {
	type AgentViewOptions,
	type AgentViewResult,
	showAgentView,
	visibleAgentRecords,
} from "../src/modes/interactive/agents/ui.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const PASSTHROUGH_TIMEOUT = 25;

function createAgentViewHarness(
	input: string,
	captureScreens = false,
): {
	open: () => ReturnType<typeof showAgentView>;
	getEditorText: () => string | undefined;
	getScreens: () => { list: string; afterInput: string } | undefined;
} {
	let editorText: string | undefined;
	let screens: { list: string; afterInput: string } | undefined;
	const fakeTui = {
		terminal: { rows: 30 },
		requestRender() {},
	};
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const keybindings = {
		matches(data: string, action: string) {
			return (
				(data === "/" && action === "app.agents.nativeCommands") || (data === "?" && action === "app.agents.help")
			);
		},
		getKeys(action: string) {
			return action === "app.agents.color" ? ["alt+c"] : [];
		},
	};
	const client = {
		async connect() {},
		async list() {
			return [];
		},
		onEvent() {
			return () => {};
		},
	};
	const context = {
		ui: {
			async custom(
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (result: AgentViewResult) => void,
				) => Component & { dispose?(): void },
			): Promise<AgentViewResult> {
				return new Promise((resolve, reject) => {
					let component: (Component & { dispose?(): void }) | undefined;
					const timeout = setTimeout(() => {
						component?.dispose?.();
						reject(new Error("Agents view did not return to native commands"));
					}, PASSTHROUGH_TIMEOUT);
					const done = (result: AgentViewResult) => {
						clearTimeout(timeout);
						component?.dispose?.();
						resolve(result);
					};
					try {
						component = factory(
							fakeTui as unknown as TUI,
							theme as Theme,
							keybindings as KeybindingsManager,
							done,
						);
						if (captureScreens) {
							const list = component.render(100).join("\n");
							component.handleInput?.(input);
							screens = { list, afterInput: component.render(100).join("\n") };
							clearTimeout(timeout);
							component.dispose?.();
							resolve({ type: "close" });
							return;
						}
						component.handleInput?.(input);
					} catch (error) {
						clearTimeout(timeout);
						reject(error);
					}
				});
			},
			setEditorText(text: string) {
				editorText = text;
			},
		},
	};
	const options: AgentViewOptions = {
		cwd: "/repo",
		model: { provider: "openai", id: "gpt-test" },
		fullscreen: true,
		getReasoning: () => ({ thinkingLevel: "high", label: "high" }),
		cycleReasoning: () => ({ thinkingLevel: "max", label: "max" }),
		projectTrusted: true,
		exit() {},
		async attach() {
			return "detached";
		},
	};

	return {
		open: () => showAgentView(context as unknown as ExtensionContext, client as unknown as SupervisorClient, options),
		getEditorText: () => editorText,
		getScreens: () => screens,
	};
}

function makeAgent(
	id: string,
	status: AgentStatus,
	timestamp: number,
	overrides: Partial<AgentRecord> = {},
): AgentRecord {
	return {
		id,
		name: id,
		prompt: `Prompt for ${id}`,
		originalCwd: "/tmp",
		cwd: "/tmp",
		thinkingLevel: "medium",
		status,
		summary: id,
		createdAt: timestamp,
		updatedAt: timestamp,
		...(status === "complete" ? { completedAt: timestamp } : {}),
		pinned: false,
		order: timestamp,
		userRenamed: false,
		isRunning: status === "working",
		isStreaming: status === "working",
		isolated: false,
		...overrides,
	};
}

describe("Agents workspace commands", () => {
	it("hands slash input from the bare workspace to the native command editor", async () => {
		const harness = createAgentViewHarness("/");
		const outcome = await harness.open();

		expect(outcome.result).toEqual({ type: "prefill", text: "/" });
		expect(harness.getEditorText()).toBe("/");
	});

	it("keeps the bare host alive when handing off to native commands", () => {
		expect(shouldExitAgentHost(true, { type: "prefill", text: "/" })).toBe(false);
		expect(shouldExitAgentHost(true, { type: "close" })).toBe(true);
		expect(shouldExitAgentHost(false, { type: "close" })).toBe(false);
	});

	it("shows the configured color shortcut in the footer and help menu", async () => {
		const harness = createAgentViewHarness("?", true);
		await harness.open();

		const screens = harness.getScreens();
		expect(screens?.list).toContain("Alt+C color");
		expect(screens?.afterInput).toContain("Alt+C");
		expect(screens?.afterInput).toContain("Set or clear color label");
	});
});

describe("visibleAgentRecords", () => {
	it("keeps every active session and only the 10 most recently edited complete sessions", () => {
		const records = [
			makeAgent("needs-input", "needs_input", 100),
			makeAgent("working", "working", 100),
			...Array.from({ length: 12 }, (_, index) =>
				makeAgent(`complete-${index + 1}`, "complete", index + 1, {
					completedAt: 100 - index,
					pinned: index === 0,
				}),
			),
		];

		const visible = visibleAgentRecords(records);
		const completedIds = visible.filter((record) => record.status === "complete").map((record) => record.id);

		expect(visible.some((record) => record.id === "needs-input")).toBe(true);
		expect(visible.some((record) => record.id === "working")).toBe(true);
		expect(completedIds).toEqual(Array.from({ length: 10 }, (_, index) => `complete-${12 - index}`));
		expect(completedIds).not.toContain("complete-1");
		expect(completedIds).not.toContain("complete-2");
	});

	it("keeps complete after the active status groups", () => {
		const visible = visibleAgentRecords([
			makeAgent("working", "working", 3),
			makeAgent("needs-input", "needs_input", 2),
			makeAgent("complete", "complete", 1),
		]);

		expect(visible.map((record) => record.status)).toEqual(["needs_input", "working", "complete"]);
	});
});
