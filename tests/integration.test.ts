import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
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
		const hashline = extractText(readResult).match(/^(\d+:[a-f0-9]{8})\|/)![1]!;

		const editResult = await edit!.execute(
			"3",
			{ path: file, edits: [{ hashline, newText: "alpha delta gamma" }] },
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

		const editResult = await edit!.execute(
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
		assert.match(extractText(editResult), /revisionId: rev_/);
		assert.match(extractText(editResult), /\[changed lines /);
		assert.match(extractText(editResult), /\d+:[a-f0-9]{8}\|THIRD/);

		const finalContent = await readFile(file, "utf-8");
		assert.equal(finalContent, "first\nsecond\ninserted-1\ninserted-2\nTHIRD\ntail");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("registered tools rebase stale hashlines across consecutive edits", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-hashline-rebase-"));
	try {
		const pi = createPiStub();
		extension(pi as any);
		const read = pi.tools.get("read");
		const write = pi.tools.get("write");
		const edit = pi.tools.get("edit");
		assert.ok(read);
		assert.ok(write);
		assert.ok(edit);

		const file = join(dir, "hashline-rebase.txt");
		await write!.execute("1", { path: file, content: "first\nsecond\nthird\n" }, undefined, undefined, { cwd: dir });
		const readResult = await read!.execute("2", { path: file, withHashlines: true }, undefined, undefined, { cwd: dir });
		const readText = extractText(readResult);
		const revisionId = (readResult.details as { revisionId?: string } | undefined)?.revisionId;
		assert.ok(revisionId);
		const secondHashline = readText.split("\n").find((line) => line.includes("|second"))?.split("|", 2)[0];
		const thirdHashline = readText.split("\n").find((line) => line.includes("|third"))?.split("|", 2)[0];
		assert.ok(secondHashline);
		assert.ok(thirdHashline);

		await edit!.execute(
			"3",
			{ path: file, baseRevisionId: revisionId, edits: [{ hashline: secondHashline, newText: "inserted-1\ninserted-2", wholeLine: false }] },
			undefined,
			undefined,
			{ cwd: dir },
		);
		const secondEdit = await edit!.execute(
			"4",
			{ path: file, baseRevisionId: revisionId, edits: [{ hashline: thirdHashline, newText: "THIRD" }] },
			undefined,
			undefined,
			{ cwd: dir },
		);
		assert.match(extractText(secondEdit), /automatic rebase/);
		const details = secondEdit.details as { rebaseState?: string; changedRanges?: Array<{ hashlines: string[] }> } | undefined;
		assert.equal(details?.rebaseState, "rebased");
		assert.ok(details?.changedRanges?.some((range) => range.hashlines.some((line) => line.includes("|THIRD"))));

		const finalContent = await readFile(file, "utf-8");
		assert.equal(finalContent, "first\nsecond\ninserted-1\ninserted-2\nTHIRD\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("registered read supports explicit ranges with context", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-read-ranges-integration-"));
	try {
		const pi = createPiStub();
		extension(pi as any);
		const read = pi.tools.get("read");
		const write = pi.tools.get("write");
		assert.ok(read);
		assert.ok(write);

		const file = join(dir, "ranges.txt");
		await write!.execute(
			"1",
			{ path: file, content: Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n") },
			undefined,
			undefined,
			{ cwd: dir },
		);
		const result = await read!.execute(
			"2",
			{ path: file, ranges: [{ start: 4, end: 5, before: 1, after: 1 }] },
			undefined,
			undefined,
			{ cwd: dir },
		);
		const text = extractText(result);
		assert.match(text, /\[lines 3-6 \| requested lines 4-5 \| context -1\/\+1\]/);
		assert.match(text, /3\|line-3/);
		assert.match(text, /6\|line-6/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("registered tools rebase stale hashlines after streaming read", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-hashline-stream-rebase-"));
	try {
		const pi = createPiStub();
		extension(pi as any);
		const read = pi.tools.get("read");
		const write = pi.tools.get("write");
		const edit = pi.tools.get("edit");
		assert.ok(read);
		assert.ok(write);
		assert.ok(edit);

		const file = join(dir, "hashline-stream-rebase.txt");
		const content = Array.from({ length: 400000 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
		await write!.execute("1", { path: file, content }, undefined, undefined, { cwd: dir });
		const readResult = await read!.execute(
			"2",
			{ path: file, offset: 1, limit: 3, withHashlines: true },
			undefined,
			undefined,
			{ cwd: dir },
		);
		const readText = extractText(readResult);
		const revisionId = (readResult.details as { revisionId?: string } | undefined)?.revisionId;
		assert.ok(revisionId);
		const thirdHashline = readText.split("\n").find((line) => line.includes("|line-3"))?.split("|", 2)[0];
		assert.ok(thirdHashline);

		await edit!.execute(
			"3",
			{ path: file, baseRevisionId: revisionId, edits: [{ hashline: readText.split("\n").find((line) => line.includes("|line-2"))?.split("|", 2)[0], newText: "inserted-a\ninserted-b", wholeLine: false }] },
			undefined,
			undefined,
			{ cwd: dir },
		);
		const secondEdit = await edit!.execute(
			"4",
			{ path: file, baseRevisionId: revisionId, edits: [{ hashline: thirdHashline, newText: "LINE-3" }] },
			undefined,
			undefined,
			{ cwd: dir },
		);
		assert.match(extractText(secondEdit), /automatic rebase/);
		const finalContent = await readFile(file, "utf-8");
		assert.match(finalContent, /^line-1\nline-2\ninserted-a\ninserted-b\nLINE-3\n/);
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
		assert.equal(await realpath(extractText(noSession).trim()), await realpath(dir));

		await bash!.execute("3", { command: "cd .." }, undefined, undefined, { cwd: dir });
		const reset = await bash!.execute("4", { command: "pwd", resetSession: true }, undefined, undefined, { cwd: dir });
		assert.equal(await realpath(extractText(reset).trim()), await realpath(dir));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
