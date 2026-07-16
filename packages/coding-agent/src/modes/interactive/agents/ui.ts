import {
	type Component,
	Editor,
	type Focusable,
	Input,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getCostLedgerPath } from "../../../config.ts";
import { DailyCostTracker, formatDailyCost } from "../../../core/daily-cost.ts";
import type { ExtensionContext } from "../../../core/extensions/types.ts";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.ts";
import { DynamicBorder } from "../components/dynamic-border.ts";
import { formatKeyText } from "../components/keybinding-hints.ts";
import { getSelectListTheme, type Theme } from "../theme/theme.ts";
import type { SupervisorClient } from "./client.ts";
import { isPlainCtrlC } from "./exit.ts";
import type { DispatchReasoningSelection } from "./reasoning.ts";
import {
	AGENT_COLORS,
	type AgentColor,
	type AgentRecord,
	type AgentStatus,
	type SupervisorEvent,
	type TerminalAttachmentResult,
} from "./types.ts";

const STATUS_ORDER: AgentStatus[] = ["needs_input", "working", "complete"];
const STATUS_LABELS: Record<AgentStatus, string> = {
	needs_input: "Needs Input",
	working: "Working",
	complete: "Complete",
};
const EMPTY_LABELS: Record<AgentStatus, string> = {
	needs_input: "No sessions need input.",
	working: "No sessions are working.",
	complete: "No completed sessions.",
};
const SPINNER = ["✶", "✳", "✢", "✳"];
const MAX_VISIBLE_COMPLETE_SESSIONS = 10;
const QUICK_OPEN_KEYBINDINGS = [
	"app.agents.open1",
	"app.agents.open2",
	"app.agents.open3",
	"app.agents.open4",
	"app.agents.open5",
	"app.agents.open6",
	"app.agents.open7",
	"app.agents.open8",
	"app.agents.open9",
] as const satisfies readonly AppKeybinding[];
const COLOR_LABELS: Record<AgentColor, string> = {
	red: "Red",
	orange: "Orange",
	yellow: "Yellow",
	green: "Green",
	blue: "Blue",
	purple: "Purple",
	pink: "Pink",
};
const COLOR_RGB: Record<AgentColor, readonly [number, number, number]> = {
	red: [255, 95, 95],
	orange: [255, 159, 67],
	yellow: [255, 215, 64],
	green: [80, 200, 120],
	blue: [88, 166, 255],
	purple: [177, 128, 255],
	pink: [255, 118, 190],
};
const COLOR_OPTIONS: ReadonlyArray<{
	color: AgentColor | undefined;
	label: string;
}> = [{ color: undefined, label: "None" }, ...AGENT_COLORS.map((color) => ({ color, label: COLOR_LABELS[color] }))];

type ViewMode = "list" | "help" | "rename" | "color";

export type AgentViewResult = { type: "close" } | { type: "prefill"; text: string };

export interface AgentViewOptions {
	cwd: string;
	model?: { provider: string; id: string };
	fullscreen?: boolean;
	getReasoning: () => DispatchReasoningSelection;
	cycleReasoning: () => DispatchReasoningSelection;
	projectTrusted: boolean;
	exit: () => void;
	attach: (tui: TUI, jobId: string) => Promise<TerminalAttachmentResult>;
}

export interface AgentViewOutcome {
	result: AgentViewResult;
	tui: TUI;
}

function formatAge(timestamp: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function shortPath(path: string): string {
	const home = process.env.HOME;
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function sorted(records: Iterable<AgentRecord>): AgentRecord[] {
	const statusRank = new Map(STATUS_ORDER.map((status, index) => [status, index]));
	return [...records].sort((a, b) => {
		if (a.status === "complete" && b.status === "complete" && a.updatedAt !== b.updatedAt) {
			return b.updatedAt - a.updatedAt;
		}
		if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
		const statusDifference = (statusRank.get(a.status) ?? 99) - (statusRank.get(b.status) ?? 99);
		if (statusDifference) return statusDifference;
		if (a.order !== b.order) return a.order - b.order;
		return b.updatedAt - a.updatedAt;
	});
}

export function visibleAgentRecords(records: Iterable<AgentRecord>): AgentRecord[] {
	const allRecords = [...records];
	const recentCompleteIds = new Set(
		allRecords
			.filter((record) => record.status === "complete")
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, MAX_VISIBLE_COMPLETE_SESSIONS)
			.map((record) => record.id),
	);
	return sorted(allRecords.filter((record) => record.status !== "complete" || recentCompleteIds.has(record.id)));
}

function fitToWidth(line: string, width: number, ellipsis = "…"): string {
	return truncateToWidth(line, Math.max(1, width), ellipsis);
}

function fill(line: string, width: number): string {
	const clipped = fitToWidth(line, width, "");
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

export function alignDailyCostFooter(help: string, cost: number, width: number): string {
	const safeWidth = Math.max(1, width);
	const costLabel = formatDailyCost(cost);
	const costWidth = visibleWidth(costLabel);
	if (costWidth >= safeWidth) return fitToWidth(costLabel, safeWidth, "");

	const availableHelpWidth = safeWidth - costWidth - 1;
	const clippedHelp = fitToWidth(help, availableHelpWidth);
	const padding = " ".repeat(Math.max(1, safeWidth - visibleWidth(clippedHelp) - costWidth));
	return fitToWidth(`${clippedHelp}${padding}${costLabel}`, safeWidth, "");
}

function colorize(color: AgentColor, text: string): string {
	const [red, green, blue] = COLOR_RGB[color];
	return `\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m`;
}

class AgentViewComponent implements Component, Focusable {
	private readonly promptEditor: Editor;
	private readonly renameInput = new Input();
	private readonly jobs = new Map<string, AgentRecord>();
	private readonly border: DynamicBorder;
	private readonly unsubscribe: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	private mode: ViewMode = "list";
	private selectedId?: string;
	private listScroll = 0;
	private colorIndex = 0;
	private spinnerFrame = 0;
	private busy = false;
	private error?: string;
	private deleteArmed?: { id: string; at: number };
	private _focused = false;
	private disposed = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly client: SupervisorClient;
	private readonly options: AgentViewOptions;
	private readonly dailyCostTracker: DailyCostTracker;
	private readonly done: (result: AgentViewResult) => void;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		client: SupervisorClient,
		options: AgentViewOptions,
		initialJobs: AgentRecord[],
		dailyCostTracker: DailyCostTracker,
		done: (result: AgentViewResult) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.client = client;
		this.options = options;
		this.dailyCostTracker = dailyCostTracker;
		this.done = done;
		for (const job of initialJobs) this.jobs.set(job.id, job);
		this.selectedId = visibleAgentRecords(this.jobs.values())[0]?.id;
		this.border = new DynamicBorder((text: string) => theme.fg("border", text));
		this.promptEditor = new Editor(
			tui,
			{
				borderColor: (text: string) => theme.fg("borderAccent", text),
				selectList: getSelectListTheme(),
			},
			{ paddingX: 1, autocompleteMaxVisible: 6 },
		);
		this.promptEditor.onSubmit = (text) => this.submitList(text);
		this.unsubscribe = client.onEvent((event) => this.handleSupervisorEvent(event));
		this.timer = setInterval(() => {
			this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
			this.tui.requestRender();
		}, 160);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.updateFocus();
	}

	private updateFocus(): void {
		this.promptEditor.focused = this._focused && this.mode === "list";
		this.renameInput.focused = this._focused && this.mode === "rename";
	}

	private setMode(mode: ViewMode): void {
		this.mode = mode;
		this.error = undefined;
		this.promptEditor.setText("");
		this.updateFocus();
		this.tui.requestRender(true);
	}

	private selected(): AgentRecord | undefined {
		return this.selectedId ? this.jobs.get(this.selectedId) : undefined;
	}

	private orderedJobs(): AgentRecord[] {
		return visibleAgentRecords(this.jobs.values());
	}

	private ensureSelection(): void {
		const jobs = this.orderedJobs();
		if (this.selectedId && jobs.some((job) => job.id === this.selectedId)) return;
		this.selectedId = jobs[0]?.id;
	}

	private handleSupervisorEvent(event: SupervisorEvent): void {
		if (this.disposed) return;
		if (event.event === "state" && event.job) {
			this.jobs.set(event.job.id, event.job);
			this.ensureSelection();
			this.tui.requestRender();
			return;
		}
		if (event.event === "removed" && event.jobId) {
			this.jobs.delete(event.jobId);
			this.ensureSelection();
			this.tui.requestRender();
		}
	}

	private runAction(action: () => Promise<void>): void {
		if (this.busy) return;
		this.busy = true;
		this.error = undefined;
		this.tui.requestRender();
		void action()
			.catch((error) => {
				this.error = error instanceof Error ? error.message : String(error);
			})
			.finally(() => {
				this.busy = false;
				if (!this.disposed) this.tui.requestRender();
			});
	}

	private moveSelection(direction: -1 | 1): void {
		const jobs = this.orderedJobs();
		if (jobs.length === 0) return;
		const index = Math.max(
			0,
			jobs.findIndex((job) => job.id === this.selectedId),
		);
		const next = Math.max(0, Math.min(jobs.length - 1, index + direction));
		this.selectedId = jobs[next]?.id;
		this.tui.requestRender();
	}

	private submitList(rawText: string): void {
		const prompt = rawText.trim();
		if (!prompt) {
			this.attachSelected();
			return;
		}
		if (prompt === "/exit") {
			this.done({ type: "close" });
			return;
		}
		if (prompt === "/agents" || prompt.startsWith("/agents ")) {
			this.error = "Agents is already open";
			this.promptEditor.setText("");
			this.tui.requestRender();
			return;
		}
		if (prompt.startsWith("/")) {
			this.done({ type: "prefill", text: prompt });
			return;
		}
		const model = this.options.model;
		if (!model) {
			this.error = "Select a model before dispatching a new session";
			this.tui.requestRender();
			return;
		}
		this.promptEditor.addToHistory(prompt);
		this.promptEditor.setText("");
		this.runAction(async () => {
			const reasoning = this.options.getReasoning();
			const job = await this.client.dispatch({
				prompt,
				cwd: this.options.cwd,
				model,
				thinkingLevel: reasoning.thinkingLevel,
				reasoningMode: reasoning.reasoningMode,
				projectTrusted: this.options.projectTrusted,
			});
			this.jobs.set(job.id, job);
			this.selectedId = job.id;
		});
	}

	private attach(job: AgentRecord | undefined): void {
		if (!job || this.busy) return;
		this.runAction(async () => {
			if ((await this.options.attach(this.tui, job.id)) === "exit") {
				this.options.exit();
			}
		});
	}

	private attachSelected(): void {
		this.attach(this.selected());
	}

	private beginRename(): void {
		const job = this.selected();
		if (!job) return;
		this.renameInput.setValue(job.name);
		this.setMode("rename");
	}

	private submitRename(): void {
		const job = this.selected();
		const name = this.renameInput.getValue().trim();
		if (!job || !name) return;
		this.runAction(async () => {
			const updated = await this.client.rename(job.id, name);
			this.jobs.set(updated.id, updated);
			this.setMode("list");
		});
	}

	private togglePin(): void {
		const job = this.selected();
		if (!job) return;
		this.runAction(async () => {
			const updated = await this.client.pin(job.id, !job.pinned);
			this.jobs.set(updated.id, updated);
		});
	}

	private beginColorLabel(): void {
		const job = this.selected();
		if (!job) return;
		this.colorIndex = Math.max(
			0,
			COLOR_OPTIONS.findIndex((option) => option.color === job.labelColor),
		);
		this.setMode("color");
	}

	private moveColorSelection(direction: -1 | 1): void {
		this.colorIndex = Math.max(0, Math.min(COLOR_OPTIONS.length - 1, this.colorIndex + direction));
		this.tui.requestRender();
	}

	private submitColorLabel(): void {
		const job = this.selected();
		const color = COLOR_OPTIONS[this.colorIndex]?.color;
		if (!job) return;
		this.runAction(async () => {
			const updated = await this.client.setColor(job.id, color);
			this.jobs.set(updated.id, updated);
			this.setMode("list");
		});
	}

	private reorder(direction: -1 | 1): void {
		const job = this.selected();
		if (!job) return;
		this.runAction(async () => {
			const records = await this.client.reorder(job.id, direction);
			for (const record of records) this.jobs.set(record.id, record);
		});
	}

	private stopOrDelete(): void {
		if (this.busy) return;
		const job = this.selected();
		if (!job) return;
		const now = Date.now();
		if (this.deleteArmed?.id === job.id && now - this.deleteArmed.at < 2_000) {
			this.deleteArmed = undefined;
			this.runAction(async () => {
				await this.client.remove(job.id);
				this.jobs.delete(job.id);
				this.ensureSelection();
			});
			return;
		}
		this.deleteArmed = { id: job.id, at: now };
		this.runAction(async () => {
			const updated = await this.client.stop(job.id);
			this.jobs.set(updated.id, updated);
		});
	}

	handleInput(data: string): void {
		if (isPlainCtrlC(data, this.keybindings)) {
			this.options.exit();
			return;
		}
		if (this.mode === "help") {
			if (
				this.keybindings.matches(data, "tui.select.cancel") ||
				this.keybindings.matches(data, "app.agents.help") ||
				this.keybindings.matches(data, "tui.select.confirm")
			) {
				this.setMode("list");
			}
			return;
		}
		if (this.mode === "color") {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.setMode("list");
			} else if (this.keybindings.matches(data, "tui.select.confirm")) {
				this.submitColorLabel();
			} else if (
				this.keybindings.matches(data, "tui.select.up") ||
				this.keybindings.matches(data, "tui.editor.cursorLeft")
			) {
				this.moveColorSelection(-1);
			} else if (
				this.keybindings.matches(data, "tui.select.down") ||
				this.keybindings.matches(data, "tui.editor.cursorRight")
			) {
				this.moveColorSelection(1);
			}
			return;
		}
		if (this.mode === "rename") {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.setMode("list");
			} else if (this.keybindings.matches(data, "tui.select.confirm")) {
				this.submitRename();
			} else {
				this.renameInput.handleInput(data);
			}
			this.tui.requestRender();
			return;
		}
		this.handleListInput(data);
	}

	private handleListInput(data: string): void {
		const inputEmpty = this.promptEditor.getText().length === 0;
		if (inputEmpty && this.keybindings.matches(data, "app.agents.nativeCommands")) {
			this.done({ type: "prefill", text: "/" });
			return;
		}
		if (this.keybindings.matches(data, "app.thinking.cycle")) {
			this.options.cycleReasoning();
			this.tui.requestRender();
			return;
		}
		if (inputEmpty && this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
		} else if (inputEmpty && this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
		} else if (inputEmpty && this.keybindings.matches(data, "app.agents.reorderUp")) {
			this.reorder(-1);
		} else if (inputEmpty && this.keybindings.matches(data, "app.agents.reorderDown")) {
			this.reorder(1);
		} else if (inputEmpty && this.keybindings.matches(data, "tui.editor.cursorRight")) {
			this.attachSelected();
		} else if (inputEmpty && this.keybindings.matches(data, "app.agents.pin")) {
			this.togglePin();
		} else if (inputEmpty && this.keybindings.matches(data, "app.agents.color")) {
			this.beginColorLabel();
		} else if (inputEmpty && this.keybindings.matches(data, "app.session.rename")) {
			this.beginRename();
		} else if (inputEmpty && this.keybindings.matches(data, "app.agents.stop")) {
			this.stopOrDelete();
		} else if (inputEmpty && this.keybindings.matches(data, "app.agents.help")) {
			this.setMode("help");
		} else if (this.keybindings.matches(data, "app.interrupt")) {
			if (!inputEmpty) this.promptEditor.setText("");
			else this.done({ type: "close" });
		} else {
			for (const [index, keybinding] of QUICK_OPEN_KEYBINDINGS.entries()) {
				if (!this.keybindings.matches(data, keybinding)) continue;
				this.attach(this.orderedJobs()[index]);
				return;
			}
			this.promptEditor.handleInput(data);
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (this.mode === "help") return this.renderHelp(safeWidth);
		if (this.mode === "rename") return this.renderRename(safeWidth);
		if (this.mode === "color") return this.renderColorLabel(safeWidth);
		return this.renderList(safeWidth);
	}

	private targetHeight(): number {
		return Math.max(1, this.tui.terminal.rows - (this.options.fullscreen === false ? 3 : 0));
	}

	private screen(lines: string[], width: number): string[] {
		const height = this.targetHeight();
		const fitted = lines.map((line) => fitToWidth(line, width, ""));
		if (fitted.length > height) return fitted.slice(fitted.length - height);
		return [...fitted, ...Array.from({ length: height - fitted.length }, () => "")];
	}

	private borderLine(width: number): string {
		return this.border.render(width)[0] || "";
	}

	private statusIcon(job: AgentRecord): string {
		const glyph = job.pinned
			? "◆"
			: job.status === "working"
				? (SPINNER[this.spinnerFrame] ?? "✶")
				: job.status === "needs_input"
					? "✻"
					: job.failed
						? "×"
						: job.stopped
							? "∙"
							: "●";
		if (job.labelColor) return colorize(job.labelColor, glyph);
		if (job.pinned || job.status === "working") {
			return this.theme.fg("accent", glyph);
		}
		if (job.status === "needs_input") return this.theme.fg("warning", glyph);
		if (job.failed) return this.theme.fg("error", glyph);
		if (job.stopped) return this.theme.fg("dim", glyph);
		return this.theme.fg("success", glyph);
	}

	private renderList(width: number): string[] {
		this.ensureSelection();
		const reasoning = this.options.getReasoning();
		const height = this.targetHeight();
		const jobs = this.orderedJobs();
		const counts = Object.fromEntries(
			STATUS_ORDER.map((status) => [status, jobs.filter((job) => job.status === status).length]),
		);
		const modelLabel = this.options.model
			? `${this.options.model.provider}/${this.options.model.id}`
			: "No dispatch model selected";
		const header = [
			this.borderLine(width),
			` ${this.theme.bold(this.theme.fg("accent", "Agents"))}`,
			this.theme.fg("muted", ` ${modelLabel} (${reasoning.label}) · ${shortPath(this.options.cwd)}`),
			this.theme.fg(
				"dim",
				` ${counts.needs_input} need input · ${counts.working} working · ${counts.complete} complete`,
			),
			"",
		];

		type ContentLine = { text: string; id?: string };
		const content: ContentLine[] = [];
		for (const status of STATUS_ORDER) {
			content.push({ text: ` ${this.theme.bold(STATUS_LABELS[status])}` });
			const group = jobs.filter((job) => job.status === status);
			if (group.length === 0) {
				content.push({
					text: `   ${this.theme.fg("dim", EMPTY_LABELS[status])}`,
				});
			} else {
				for (const job of group) {
					content.push({
						text: this.renderJobRow(job, Math.max(1, width - 1)),
						id: job.id,
					});
				}
			}
			content.push({ text: "" });
		}

		const editorLines = this.promptEditor.render(width);
		const footerHeight = 2;
		const budget = Math.max(1, height - header.length - editorLines.length - footerHeight);
		const selectedLine = this.selectedId ? content.findIndex((line) => line.id === this.selectedId) : -1;
		if (selectedLine >= 0) {
			if (selectedLine < this.listScroll) this.listScroll = selectedLine;
			if (selectedLine >= this.listScroll + budget) {
				this.listScroll = selectedLine - budget + 1;
			}
		}
		this.listScroll = Math.max(0, Math.min(this.listScroll, Math.max(0, content.length - budget)));
		const visibleContent = content
			.slice(this.listScroll, this.listScroll + budget)
			.map((line) =>
				line.id && line.id === this.selectedId
					? this.theme.bg("selectedBg", fill(line.text, Math.max(1, width - 1)))
					: line.text,
			);
		while (visibleContent.length < budget) visibleContent.push("");

		return this.screen(
			[
				...header,
				...visibleContent,
				...editorLines,
				this.theme.fg("dim", ` ${this.listFooter()}`),
				this.theme.fg(
					"dim",
					alignDailyCostFooter(
						" Enter dispatch/open native Pi · / native commands · ? help",
						this.dailyCostTracker.getTotal(),
						width,
					),
				),
			],
			width,
		);
	}

	private renderJobRow(job: AgentRecord, width: number): string {
		const age = formatAge(job.updatedAt);
		const nameWidth = Math.max(12, Math.min(30, Math.floor(width * 0.27)));
		const icon = this.statusIcon(job);
		const name = fitToWidth(job.name, nameWidth).padEnd(nameWidth);
		const isolation = job.isolated || job.discovered ? "" : this.theme.fg("warning", " !");
		const summaryWidth = Math.max(1, width - nameWidth - age.length - visibleWidth(isolation) - 6);
		const summary = fitToWidth(job.summary || "", summaryWidth).padEnd(summaryWidth);
		return fitToWidth(
			`  ${icon} ${name}${isolation} ${this.theme.fg("muted", summary)} ${this.theme.fg("dim", age)}`,
			width,
			"",
		);
	}

	private keybindingLabel(keybinding: AppKeybinding): string {
		return formatKeyText(this.keybindings.getKeys(keybinding).join("/"), { capitalize: true });
	}

	private listFooter(): string {
		if (this.error) return `Error: ${this.error}`;
		if (this.busy) return "Working…";
		const job = this.selected();
		if (job && this.deleteArmed?.id === job.id && Date.now() - this.deleteArmed.at < 2_000) {
			return job.worktreePath
				? "Ctrl+X again deletes the session, branch, and worktree changes"
				: "Ctrl+X again deletes the session";
		}
		return `↑↓ select · → attach · ${this.keybindingLabel("app.agents.color")} color · Ctrl+T pin · Ctrl+R rename · Ctrl+X stop/delete`;
	}

	private renderHelp(width: number): string[] {
		const colorKey = this.keybindingLabel("app.agents.color");
		const lines = [
			this.borderLine(width),
			` ${this.theme.bold(this.theme.fg("accent", "Agents shortcuts"))}`,
			"",
			" ↑ / ↓             Select a session",
			" Enter / →         Open the selected native Pi session",
			" Alt+1 … Alt+9     Open session 1–9",
			` ${colorKey.padEnd(18)}Set or clear color label`,
			" Ctrl+T            Pin or unpin",
			" Ctrl+R            Rename",
			" Shift+↑ / ↓       Reorder within a category",
			" Ctrl+X            Stop; press again to delete",
			" Shift+Tab         Cycle dispatch thinking level",
			" /                 Return to native slash commands",
			" Ctrl+C            Exit Pi (agents keep running)",
			" Ctrl+Shift+C      Terminal copy (does not exit)",
			" Esc               Clear input or close Agents",
			"",
			this.theme.fg("dim", " Attached sessions are native Pi; press ← on an empty prompt or use /agents to detach."),
			"",
			this.theme.fg("dim", " Press ?, Enter, or Esc to close help"),
		];
		return this.screen(lines, width);
	}

	private renderColorLabel(width: number): string[] {
		const job = this.selected();
		const lines = [
			this.borderLine(width),
			` ${this.theme.bold(this.theme.fg("accent", "Color label"))}`,
			this.theme.fg("muted", ` ${job?.name || "No agent selected"}`),
			"",
		];
		for (const [index, option] of COLOR_OPTIONS.entries()) {
			const marker = option.color ? colorize(option.color, "●") : this.theme.fg("dim", "○");
			const row = fill(`  ${marker} ${option.label}`, Math.max(1, width - 1));
			lines.push(index === this.colorIndex ? this.theme.bg("selectedBg", row) : row);
		}
		lines.push("", this.theme.fg("dim", ` ${this.error || "↑↓/←→ choose · Enter save · Esc cancel"}`));
		return this.screen(lines, width);
	}

	private renderRename(width: number): string[] {
		const inputLine = this.renameInput.render(Math.max(1, width - 2))[0] || "";
		return this.screen(
			[
				this.borderLine(width),
				` ${this.theme.bold(this.theme.fg("accent", "Rename agent session"))}`,
				"",
				` ${inputLine}`,
				"",
				this.theme.fg("dim", ` ${this.error || "Enter save · Esc cancel"}`),
			],
			width,
		);
	}

	invalidate(): void {
		this.promptEditor.invalidate();
		this.renameInput.invalidate();
		this.border.invalidate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.timer);
		this.unsubscribe();
	}
}

export async function showAgentView(
	ctx: ExtensionContext,
	client: SupervisorClient,
	options: AgentViewOptions,
): Promise<AgentViewOutcome> {
	await client.connect(true);
	const listedJobs = await client.list();
	const initialJobs = Array.isArray(listedJobs) ? listedJobs : [];
	const dailyCostTracker = new DailyCostTracker(getCostLedgerPath());
	let activeTui: TUI | undefined;
	const result = await ctx.ui.custom<AgentViewResult>(
		(tui, theme, keybindings, done) => {
			activeTui = tui;
			const finish = (result: AgentViewResult) => {
				done(result);
				if (result.type === "prefill") ctx.ui.setEditorText(result.text);
			};
			return new AgentViewComponent(tui, theme, keybindings, client, options, initialJobs, dailyCostTracker, finish);
		},
		{ fullscreen: options.fullscreen },
	);
	if (!activeTui) throw new Error("Agents view did not initialize");
	return { result, tui: activeTui };
}
