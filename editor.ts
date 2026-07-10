import type {
	AppKeybinding,
	ExtensionContext,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type EditorComponent,
	type EditorTheme,
	matchesKey,
	type TUI,
} from "@earendil-works/pi-tui";

/**
 * Adds one navigation gesture without replacing the editor's normal behavior.
 * Pi wires its native app actions into this wrapper after construction; all
 * unhandled input is delegated to the editor that was active before Agents.
 */
type AppAwareEditor = EditorComponent & {
	actionHandlers: Map<AppKeybinding, () => void>;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
};

class AgentsNavigationEditor implements EditorComponent {
	readonly actionHandlers = new Map<AppKeybinding, () => void>();
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
	private _focused = false;

	constructor(
		private readonly base: EditorComponent,
		private readonly keybindings: KeybindingsManager,
		private readonly onEmptyLeft: () => void,
		private readonly onSuspend?: () => void,
	) {
		const appAware = this.getAppAwareBase();
		if (!appAware) return;
		this.onEscape = appAware.onEscape;
		this.onCtrlD = appAware.onCtrlD;
		this.onPasteImage = appAware.onPasteImage;
		this.onExtensionShortcut = appAware.onExtensionShortcut;
		for (const [action, handler] of appAware.actionHandlers) {
			this.actionHandlers.set(action, handler);
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if ("focused" in this.base) {
			(this.base as EditorComponent & { focused: boolean }).focused = value;
		}
	}

	get onSubmit(): ((text: string) => void) | undefined {
		return this.base.onSubmit;
	}
	set onSubmit(value: ((text: string) => void) | undefined) {
		this.base.onSubmit = value;
	}

	get onChange(): ((text: string) => void) | undefined {
		return this.base.onChange;
	}
	set onChange(value: ((text: string) => void) | undefined) {
		this.base.onChange = value;
	}

	get borderColor(): ((text: string) => string) | undefined {
		return this.base.borderColor;
	}
	set borderColor(value: ((text: string) => string) | undefined) {
		if (value) this.base.borderColor = value;
	}

	private getAppAwareBase(): AppAwareEditor | undefined {
		if (
			"actionHandlers" in this.base &&
			(this.base as { actionHandlers?: unknown }).actionHandlers instanceof Map
		) {
			return this.base as AppAwareEditor;
		}
		return undefined;
	}

	private syncAppHandlersToBase(): boolean {
		const appAware = this.getAppAwareBase();
		if (!appAware) return false;
		appAware.onEscape = this.onEscape;
		appAware.onCtrlD = this.onCtrlD;
		appAware.onPasteImage = this.onPasteImage;
		appAware.onExtensionShortcut = this.onExtensionShortcut;
		appAware.actionHandlers.clear();
		for (const [action, handler] of this.actionHandlers) {
			appAware.actionHandlers.set(action, handler);
		}
		return true;
	}

	handleInput(data: string): void {
		if (this.onSuspend && this.keybindings.matches(data, "app.suspend")) {
			this.onSuspend();
			return;
		}
		if (matchesKey(data, "left") && this.base.getText().length === 0) {
			this.onEmptyLeft();
			return;
		}

		// Let CustomEditor subclasses retain their own modal behavior while using
		// the exact native Pi action handlers copied onto this wrapper.
		if (this.syncAppHandlersToBase()) {
			this.base.handleInput(data);
			return;
		}

		// Fallback for a custom base editor that does not expose Pi app actions.
		if (this.onExtensionShortcut?.(data)) return;
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}
		if (this.keybindings.matches(data, "app.interrupt")) {
			const showingAutocomplete =
				"isShowingAutocomplete" in this.base &&
				typeof (this.base as { isShowingAutocomplete?: () => boolean })
					.isShowingAutocomplete === "function" &&
				(
					this.base as { isShowingAutocomplete: () => boolean }
				).isShowingAutocomplete();
			if (!showingAutocomplete) {
				const handler =
					this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
		}
		if (
			this.keybindings.matches(data, "app.exit") &&
			this.base.getText().length === 0
		) {
			const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
			if (handler) {
				handler();
				return;
			}
		}
		for (const [action, handler] of this.actionHandlers) {
			if (
				action !== "app.interrupt" &&
				action !== "app.exit" &&
				this.keybindings.matches(data, action)
			) {
				handler();
				return;
			}
		}
		this.base.handleInput(data);
	}

	submitCommand(command: string): void {
		this.onSubmit?.(command);
	}

	render(width: number): string[] {
		return this.base.render(width);
	}

	invalidate(): void {
		this.base.invalidate();
	}

	getText(): string {
		return this.base.getText();
	}

	setText(text: string): void {
		this.base.setText(text);
	}

	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.base.insertTextAtCursor?.(text);
	}

	getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.base.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}
}

export function installAgentsNavigationEditor(
	context: ExtensionContext,
	createDefault: (
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
	) => EditorComponent,
	onEmptyLeft: (editor: AgentsNavigationEditor) => void,
	onSuspend?: () => void,
): void {
	const previousFactory = context.ui.getEditorComponent();
	context.ui.setEditorComponent((tui, theme, keybindings) => {
		const base =
			previousFactory?.(tui, theme, keybindings) ??
			createDefault(tui, theme, keybindings);
		let editor: AgentsNavigationEditor;
		editor = new AgentsNavigationEditor(
			base,
			keybindings,
			() => onEmptyLeft(editor),
			onSuspend,
		);
		return editor;
	});
}
