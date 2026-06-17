import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";

type ToolDef = {
	name: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
		ctx: { cwd: string },
	) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};

function createPiStub() {
	const tools = new Map<string, ToolDef>();
	return {
		registerTool(def: ToolDef) {
			tools.set(def.name, def);
		},
		on(_event: string, _handler: unknown) {},
		tools,
	};
}

function extractText(result: { content: Array<{ type: string; text: string }> }): string {
	return result.content.map((item) => item.text).join("\n");
}

test("registered tools work end-to-end through extension entry", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-e2e-"));
	try {
		const pi = createPiStub();
		extension(pi as any);
		const read = pi.tools.get("read");
		const write = pi.tools.get("write");
		const edit = pi.tools.get("edit");
		assert.ok(read);
		assert.ok(write);
		assert.ok(edit);

		const file = join(dir, "e2e.txt");
		await write!.execute("1", { path: file, content: "alpha beta gamma" }, undefined, undefined, { cwd: dir });
		const readResult = await read!.execute(
			"2",
			{ path: file, offset: 1, limit: 1, withHashlines: true },
			undefined,
			undefined,
			{ cwd: dir },
		);
		assert.match(extractText(readResult), /^1:[a-f0-9]{8}\|alpha beta gamma/m);

		const editResult = await edit!.execute(
			"3",
			{ path: file, edits: [{ oldText: "beta", newText: "delta" }] },
			undefined,
			undefined,
			{ cwd: dir },
		);
		assert.match(extractText(editResult), /Successfully applied 1 edit/);

		const finalContent = await readFile(file, "utf-8");
		assert.equal(finalContent, "alpha delta gamma");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("registered tools support hashline-guided edit flow", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-hashline-"));
	try {
		const pi = createPiStub();
		extension(pi as any);
		const read = pi.tools.get("read");
		const write = pi.tools.get("write");
		const edit = pi.tools.get("edit");
		assert.ok(read);
		assert.ok(write);
		assert.ok(edit);

		const file = join(dir, "hashline.txt");
		await write!.execute("1", { path: file, content: "first\nsecond\nthird" }, undefined, undefined, { cwd: dir });
		const readResult = await read!.execute(
			"2",
			{ path: file, offset: 1, limit: 3, withHashlines: true },
			undefined,
			undefined,
			{ cwd: dir },
		);
		const hashline = extractText(readResult)
			.split("\n")
			.find((line) => line.includes("|second"))
			?.split("|")[0];
		assert.ok(hashline);

		await edit!.execute(
			"3",
			{ path: file, edits: [{ hashline, newText: "SECOND" }] },
			undefined,
			undefined,
			{ cwd: dir },
		);

		const finalContent = await readFile(file, "utf-8");
		assert.equal(finalContent, "first\nSECOND\nthird");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
