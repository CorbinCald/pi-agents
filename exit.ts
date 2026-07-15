import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type KeyMatcher = (data: string, key: "ctrl+c" | "ctrl+shift+c") => boolean;

export function isPlainCtrlC(data: string, matchesKey: KeyMatcher): boolean {
	return matchesKey(data, "ctrl+c") && !matchesKey(data, "ctrl+shift+c");
}

export function requestSinglePressExit(context: ExtensionContext): void {
	context.shutdown();
	if (!context.isIdle()) context.abort();
}

/** Make Ctrl+C a global, consuming exit gesture before focused UI handles it. */
export function installSinglePressExit(
	context: ExtensionContext,
	matchesKey: KeyMatcher,
): () => void {
	let requested = false;
	return context.ui.onTerminalInput((data) => {
		if (!isPlainCtrlC(data, matchesKey)) return;
		if (!requested) {
			requested = true;
			requestSinglePressExit(context);
		}
		return { consume: true };
	});
}
