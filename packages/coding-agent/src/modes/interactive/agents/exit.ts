import type { ExtensionContext } from "../../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";

export function isPlainCtrlC(data: string, keybindings: KeybindingsManager): boolean {
	return keybindings.matches(data, "app.agents.exitHost") && !keybindings.matches(data, "app.agents.terminalCopy");
}

export function requestSinglePressExit(context: ExtensionContext): void {
	context.shutdown();
	if (!context.isIdle()) context.abort();
}

/** Make Ctrl+C a global, consuming exit gesture before focused UI handles it. */
export function installSinglePressExit(context: ExtensionContext, keybindings: KeybindingsManager): () => void {
	let requested = false;
	return context.ui.onTerminalInput((data) => {
		if (!isPlainCtrlC(data, keybindings)) return;
		if (!requested) {
			requested = true;
			requestSinglePressExit(context);
		}
		return { consume: true };
	});
}
