import assert from "node:assert/strict";
import test from "node:test";
import {
	DispatchReasoningController,
	supportsMaxProReasoning,
	withMaxProReasoning,
} from "../reasoning.ts";

const GPT_56_SOL = {
	provider: "openai",
	id: "gpt-5.6-sol",
	api: "openai-responses",
	reasoning: true,
};

test("Max Pro follows max only for supported GPT-5.6 models", () => {
	let level = "xhigh";
	const controller = new DispatchReasoningController(
		{
			getThinkingLevel: () => level,
			setThinkingLevel: (next) => {
				level = next;
			},
		},
		() => GPT_56_SOL,
	);

	assert.deepEqual(controller.getSelection(), {
		thinkingLevel: "xhigh",
		label: "xhigh",
	});
	assert.deepEqual(controller.cycle(), {
		thinkingLevel: "max",
		label: "max",
	});
	assert.deepEqual(controller.cycle(), {
		thinkingLevel: "max",
		reasoningMode: "pro",
		label: "Max Pro",
	});
	assert.deepEqual(controller.cycle(), {
		thinkingLevel: "off",
		label: "off",
	});
});

test("native reasoning cycling handles only the max and Max Pro boundary", () => {
	let level = "xhigh";
	const controller = new DispatchReasoningController(
		{
			getThinkingLevel: () => level,
			setThinkingLevel: (next) => {
				level = next;
			},
		},
		() => GPT_56_SOL,
	);

	assert.equal(controller.cycleMaxProBoundary(), undefined);
	level = "max";
	assert.deepEqual(controller.cycleMaxProBoundary(), {
		thinkingLevel: "max",
		reasoningMode: "pro",
		label: "Max Pro",
	});
	assert.deepEqual(controller.cycleMaxProBoundary(), {
		thinkingLevel: "off",
		label: "off",
	});
});

test("Max Pro is skipped for models without direct OpenAI GPT-5.6 Pro support", () => {
	for (const model of [
		{ ...GPT_56_SOL, provider: "openai-codex", api: "openai-codex-responses" },
		{ ...GPT_56_SOL, provider: "github-copilot" },
		{ ...GPT_56_SOL, id: "gpt-5.5" },
		{ ...GPT_56_SOL, id: "gpt-5.6-unknown" },
		{ ...GPT_56_SOL, reasoning: false },
	]) {
		let level = "max";
		const controller = new DispatchReasoningController(
			{
				getThinkingLevel: () => level,
				setThinkingLevel: (next) => {
					level = next;
				},
			},
			() => model,
		);

		assert.equal(supportsMaxProReasoning(model), false);
		assert.deepEqual(controller.cycle(), {
			thinkingLevel: "off",
			label: "off",
		});
	}
});

test("Max Pro provider payload preserves reasoning options and forces max Pro", () => {
	const payload = {
		model: "gpt-5.6-sol",
		reasoning: { effort: "max", summary: "auto" },
		input: "test",
	};

	assert.deepEqual(withMaxProReasoning(payload), {
		model: "gpt-5.6-sol",
		reasoning: { effort: "max", summary: "auto", mode: "pro" },
		input: "test",
	});
	assert.deepEqual(payload.reasoning, { effort: "max", summary: "auto" });
});
