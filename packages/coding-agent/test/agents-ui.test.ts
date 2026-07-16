import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SupervisorClient } from "../src/modes/interactive/agents/client.ts";
import { shouldExitAgentHost } from "../src/modes/interactive/agents/index.ts";
import { type AgentViewOptions, type AgentViewResult, showAgentView } from "../src/modes/interactive/agents/ui.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const PASSTHROUGH_TIMEOUT = 25;

function createAgentViewHarness(input: string): {
	open: () => ReturnType<typeof showAgentView>;
	getEditorText: () => string | undefined;
} {
	let editorText: string | undefined;
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
			return data === "/" && action === "app.agents.nativeCommands";
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
});
