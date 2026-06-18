import test from "node:test";
import assert from "node:assert/strict";
import extension from "../index.ts";

function createPiStub() {
	const tools: Array<{ name: string }> = [];
	const events: string[] = [];
	return {
		tools,
		events,
		registerTool(def: { name: string }) {
			tools.push({ name: def.name });
		},
		on(event: string, _handler: unknown) {
			events.push(event);
		},
	};
}

test("extension entry registers read/edit/write and session_start hook", () => {
	const pi = createPiStub();
	extension(pi as any);
	assert.deepEqual(
		pi.tools.map((tool) => tool.name).sort(),
		["edit", "read", "write"],
	);
});
