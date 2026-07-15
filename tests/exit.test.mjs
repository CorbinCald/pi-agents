import assert from "node:assert/strict";
import test from "node:test";
import { installSinglePressExit } from "../exit.ts";

const CTRL_SHIFT_C = "\u001b[99;6u";
function matchesTestKey(data, key) {
	if (data === "\u0003") return key === "ctrl+c";
	if (data === CTRL_SHIFT_C) return key === "ctrl+shift+c";
	return false;
}

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
	const unsubscribe = installSinglePressExit(active.context, matchesTestKey);

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
	installSinglePressExit(idle.context, matchesTestKey);
	assert.deepEqual(idle.input("\u0003"), { consume: true });
	assert.deepEqual(idle.events, ["listen", "shutdown", "isIdle"]);
});
