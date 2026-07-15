import assert from "node:assert/strict";
import test from "node:test";
import { installSinglePressExit } from "../../src/modes/interactive/agents/exit.ts";

const CTRL_SHIFT_C = "\u001b[99;6u";
const keybindings = {
	matches(data, keybinding) {
		if (data === "\u0003") return keybinding === "app.agents.exitHost";
		if (data === CTRL_SHIFT_C) return keybinding === "app.agents.terminalCopy";
		return false;
	},
};

function exitContext(idle) {
	const events = [];
	let listener;
	return {
		context: {
			ui: {
				onTerminalInput(handler) {
					listener = handler;
					events.push("listen");
					return () => events.push("unlisten");
				},
			},
			shutdown() {
				events.push("shutdown");
			},
			isIdle() {
				events.push("isIdle");
				return idle;
			},
			abort() {
				events.push("abort");
			},
		},
		events,
		input(data) {
			return listener?.(data);
		},
	};
}

test("only plain Ctrl+C globally consumes input and requests graceful exit", () => {
	const active = exitContext(false);
	const unsubscribe = installSinglePressExit(active.context, keybindings);

	assert.equal(active.input("x"), undefined);
	assert.equal(active.input(CTRL_SHIFT_C), undefined);
	assert.deepEqual(active.events, ["listen"]);
	assert.deepEqual(active.input("\u0003"), { consume: true });
	assert.deepEqual(active.events, ["listen", "shutdown", "isIdle", "abort"]);

	// Repeated input is consumed while shutdown settles, without duplicate work.
	assert.deepEqual(active.input("\u0003"), { consume: true });
	assert.deepEqual(active.events, ["listen", "shutdown", "isIdle", "abort"]);
	unsubscribe();
	assert.equal(active.events.at(-1), "unlisten");

	const idle = exitContext(true);
	installSinglePressExit(idle.context, keybindings);
	assert.deepEqual(idle.input("\u0003"), { consume: true });
	assert.deepEqual(idle.events, ["listen", "shutdown", "isIdle"]);
});
