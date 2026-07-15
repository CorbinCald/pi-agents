const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type DispatchReasoningSelection = {
	thinkingLevel: ThinkingLevel;
	reasoningMode?: "pro";
	label: string;
};

type ReasoningModel = {
	provider?: string;
	id?: string;
	api?: string;
	reasoning?: boolean;
};

type ThinkingControls = {
	getThinkingLevel: () => ThinkingLevel;
	setThinkingLevel: (level: ThinkingLevel) => void;
};

export function supportsMaxProReasoning(model: ReasoningModel | undefined): boolean {
	if (
		model?.provider !== "openai" ||
		typeof model.id !== "string" ||
		!/^gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/.test(model.id)
	) {
		return false;
	}
	if (model.api !== undefined && model.api !== "openai-responses") return false;
	if (model.reasoning !== undefined && model.reasoning !== true) return false;
	return true;
}

export class DispatchReasoningController {
	private readonly controls: ThinkingControls;
	private readonly getModel: () => ReasoningModel | undefined;
	private maxProSelected = false;

	constructor(controls: ThinkingControls, getModel: () => ReasoningModel | undefined) {
		this.controls = controls;
		this.getModel = getModel;
	}

	getSelection(): DispatchReasoningSelection {
		const thinkingLevel = this.controls.getThinkingLevel();
		if (this.maxProSelected && (thinkingLevel !== "max" || !supportsMaxProReasoning(this.getModel()))) {
			this.maxProSelected = false;
		}
		if (this.maxProSelected) {
			return { thinkingLevel: "max", reasoningMode: "pro", label: "Max Pro" };
		}
		return { thinkingLevel, label: thinkingLevel };
	}

	cycleMaxProBoundary(): DispatchReasoningSelection | undefined {
		const current = this.getSelection();
		if (
			current.reasoningMode !== "pro" &&
			(current.thinkingLevel !== "max" || !supportsMaxProReasoning(this.getModel()))
		) {
			return undefined;
		}
		return this.cycle();
	}

	cycle(): DispatchReasoningSelection {
		const current = this.getSelection();
		if (
			current.thinkingLevel === "max" &&
			current.reasoningMode !== "pro" &&
			supportsMaxProReasoning(this.getModel())
		) {
			this.maxProSelected = true;
			return this.getSelection();
		}

		this.maxProSelected = false;
		const currentIndex = Math.max(0, THINKING_LEVELS.indexOf(current.thinkingLevel));
		for (let offset = 1; offset <= THINKING_LEVELS.length; offset++) {
			const candidate = THINKING_LEVELS[(currentIndex + offset) % THINKING_LEVELS.length];
			if (!candidate) continue;
			this.controls.setThinkingLevel(candidate);
			if (this.controls.getThinkingLevel() !== current.thinkingLevel) {
				return this.getSelection();
			}
		}
		return this.getSelection();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function withMaxProReasoning(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;
	const reasoning = isRecord(payload.reasoning) ? payload.reasoning : {};
	return {
		...payload,
		reasoning: {
			...reasoning,
			effort: "max",
			mode: "pro",
		},
	};
}
