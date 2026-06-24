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
			?.split("|", 2)[0];
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

test("registered tools apply multiple hashline edits from one read snapshot", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-hashline-batch-"));
	try {
		const pi = createPiStub();
		extension(pi as any);
		const read = pi.tools.get("read");
		const write = pi.tools.get("write");
		const edit = pi.tools.get("edit");
		assert.ok(read);
		assert.ok(write);
		assert.ok(edit);

		const file = join(dir, "hashline-batch.txt");
		await write!.execute("1", { path: file, content: "first\nsecond\nthird\n" }, undefined, undefined, { cwd: dir });
		const readResult = await read!.execute(
			"2",
			{ path: file, withHashlines: true },
			undefined,
			undefined,
			{ cwd: dir },
		);
		const anchors = new Map(
			extractText(readResult)
				.split("\n")
				.filter((line) => /^\d+:[a-f0-9]{8}\|/.test(line))
				.map((line) => {
					const [hashline, content] = line.split("|", 2);
					return [content, hashline];
				}),
		);

		await edit!.execute(
			"3",
			{
				path: file,
				edits: [
					{ hashline: anchors.get("second"), newText: "inserted-1\ninserted-2", wholeLine: false },
					{ hashline: anchors.get("third"), newText: "THIRD" },
					{ hashline: anchors.get(""), newText: "tail" },
				],
			},
			undefined,
			undefined,
			{ cwd: dir },
		);

		const finalContent = await readFile(file, "utf-8");
		assert.equal(finalContent, "first\nsecond\ninserted-1\ninserted-2\nTHIRD\ntail");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("registered native find and grep work end-to-end", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-native-search-"));
	try {
		const pi = createPiStub();
		extension(pi as any);
		const write = pi.tools.get("write");
		const find = pi.tools.get("find");
		const grep = pi.tools.get("grep");
		assert.ok(write);
		assert.ok(find);
		assert.ok(grep);

		await write!.execute("1", { path: join(dir, "src", "main.ts"), content: "const needle = 1;\n" }, undefined, undefined, { cwd: dir });
		await write!.execute("2", { path: join(dir, "src", "other.js"), content: "nothing\n" }, undefined, undefined, { cwd: dir });

		const findResult = await find!.execute("3", { pattern: "*.ts", path: join(dir, "src") }, undefined, undefined, { cwd: dir });
		assert.match(extractText(findResult), /main\.ts/);

		const grepResult = await grep!.execute(
			"4",
			{ pattern: "needle", path: join(dir, "src"), glob: "*.ts", context: 0, limit: 10 },
			undefined,
			undefined,
			{ cwd: dir },
		);
		assert.match(extractText(grepResult), /main\.ts:1: const needle = 1;/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("registered native find and grep stream progress updates", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-native-stream-updates-"));
	try {
		const pi = createPiStub();
		extension(pi as any);
		const write = pi.tools.get("write");
		const find = pi.tools.get("find");
		const grep = pi.tools.get("grep");
		assert.ok(write);
		assert.ok(find);
		assert.ok(grep);

		await write!.execute("1", { path: join(dir, "src", "a.ts"), content: "needle\n" }, undefined, undefined, { cwd: dir });
		await write!.execute("2", { path: join(dir, "src", "b.ts"), content: "needle\n" }, undefined, undefined, { cwd: dir });

		const findUpdates: string[] = [];
		await find!.execute(
			"3",
			{ pattern: "*.ts", path: join(dir, "src") },
			undefined,
			(update) => {
				findUpdates.push(extractText(update as any));
			},
			{ cwd: dir },
		);
		assert.ok(findUpdates.length >= 1);
		assert.match(findUpdates[0] ?? "", /\.ts/);

		const grepUpdates: string[] = [];
		await grep!.execute(
			"4",
			{ pattern: "needle", path: join(dir, "src"), glob: "*.ts", limit: 10 },
			undefined,
			(update) => {
				grepUpdates.push(extractText(update as any));
			},
			{ cwd: dir },
		);
		assert.ok(grepUpdates.length >= 1);
		assert.match(grepUpdates[0] ?? "", /needle/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("registered native grep supports count and filesWithMatches modes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-native-grep-modes-"));
	try {
		const pi = createPiStub();
		extension(pi as any);
		const write = pi.tools.get("write");
		const grep = pi.tools.get("grep");
		assert.ok(write);
		assert.ok(grep);

		await write!.execute("1", { path: join(dir, "src", "a.ts"), content: "needle\nneedle\n" }, undefined, undefined, { cwd: dir });
		await write!.execute("2", { path: join(dir, "src", "b.ts"), content: "needle\n" }, undefined, undefined, { cwd: dir });

		const countResult = await grep!.execute(
			"3",
			{ pattern: "needle", path: join(dir, "src"), glob: "*.ts", limit: 10, mode: "count" },
			undefined,
			undefined,
			{ cwd: dir },
		);
		assert.match(extractText(countResult), /a\.ts: 2/);
		assert.match(extractText(countResult), /b\.ts: 1/);

		const filesResult = await grep!.execute(
			"4",
			{ pattern: "needle", path: join(dir, "src"), glob: "*.ts", limit: 10, mode: "filesWithMatches" },
			undefined,
			undefined,
			{ cwd: dir },
		);
		assert.match(extractText(filesResult), /a\.ts/);
		assert.match(extractText(filesResult), /b\.ts/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("registered native bash keeps session state across calls", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-native-bash-"));
	try {
		const pi = createPiStub();
		extension(pi as any);
		const bash = pi.tools.get("bash");
		assert.ok(bash);

		const first = await bash!.execute("1", { command: "cd .. && pwd" }, undefined, undefined, { cwd: dir });
		const second = await bash!.execute("2", { command: "pwd" }, undefined, undefined, { cwd: dir });
		assert.equal(extractText(second).trim(), extractText(first).trim());
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("registered native bash supports session controls", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-native-bash-session-controls-"));
	try {
		const pi = createPiStub();
		extension(pi as any);
		const bash = pi.tools.get("bash");
		assert.ok(bash);

		await bash!.execute("1", { command: "cd .. && pwd", session: false }, undefined, undefined, { cwd: dir });
		const noSession = await bash!.execute("2", { command: "pwd", session: false }, undefined, undefined, { cwd: dir });
		assert.equal(extractText(noSession).trim(), dir);

		await bash!.execute("3", { command: "cd .." }, undefined, undefined, { cwd: dir });
		const reset = await bash!.execute("4", { command: "pwd", resetSession: true }, undefined, undefined, { cwd: dir });
		assert.equal(extractText(reset).trim(), dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
