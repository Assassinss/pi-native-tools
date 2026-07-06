import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STREAMING_THRESHOLD, STREAM_READ_CHUNK_SIZE } from "../extensions/shared.ts";
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
		const readResult = await read!.execute("2", { path: file, offset: 1, limit: 1 }, undefined, undefined, { cwd: dir });
		const snapshotId = (readResult.details as { snapshotId?: string } | undefined)?.snapshotId;
		assert.ok(snapshotId);

		const editResult = await edit!.execute(
			"3",
			{ path: file, snapshotId, oldText: "alpha beta gamma", newText: "alpha delta gamma" },
			undefined,
			undefined,
			{ cwd: dir },
		);
		assert.match(extractText(editResult), /Applied 1 replacement/);

		const finalContent = await readFile(file, "utf-8");
		assert.equal(finalContent, "alpha delta gamma");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("registered edit applies snapshot-based exact replacement", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-"));
	try {
		const pi = createPiStub();
		extension(pi as any);
		const read = pi.tools.get("read");
		const write = pi.tools.get("write");
		const edit = pi.tools.get("edit");
		assert.ok(read);
		assert.ok(write);
		assert.ok(edit);

		const file = join(dir, "edit.txt");
		await write!.execute("1", { path: file, content: "first\nsecond\nthird\n" }, undefined, undefined, { cwd: dir });
		const readResult = await read!.execute("2", { path: file, offset: 2, limit: 1 }, undefined, undefined, { cwd: dir });
		const snapshotId = (readResult.details as { snapshotId?: string } | undefined)?.snapshotId;
		assert.ok(snapshotId);

		await edit!.execute(
			"3",
			{ path: file, snapshotId, oldText: "second", newText: "SECOND" },
			undefined,
			undefined,
			{ cwd: dir },
		);

		const finalContent = await readFile(file, "utf-8");
		assert.equal(finalContent, "first\nSECOND\nthird\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("registered edit returns ambiguous conflicts with previews", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-ambiguous-"));
	try {
		const pi = createPiStub();
		extension(pi as any);
		const edit = pi.tools.get("edit");
		const write = pi.tools.get("write");
		assert.ok(edit);
		assert.ok(write);

		const file = join(dir, "ambiguous.txt");
		await write!.execute("1", { path: file, content: "x\nrepeat\ny\nrepeat\n" }, undefined, undefined, { cwd: dir });
		const result = await edit!.execute(
			"2",
			{ path: file, oldText: "repeat", newText: "done" },
			undefined,
			undefined,
			{ cwd: dir },
		);
		const details = result.details as { status?: string; reason?: string; candidates?: Array<{ preview: string }> } | undefined;
		assert.equal(details?.status, "conflict");
		assert.equal(details?.reason, "ambiguous");
		assert.ok(details?.candidates?.length);
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

test("registered read reports offset past EOF for streamed files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-read-stream-eof-"));
	try {
		const pi = createPiStub();
		extension(pi as any);
		const read = pi.tools.get("read");
		assert.ok(read);

		const file = join(dir, "stream-eof.txt");
		await writeFile(file, `line-1\nline-2\n${"x".repeat(STREAMING_THRESHOLD)}`, "utf-8");
		const result = await read!.execute("1", { path: file, offset: 5, limit: 1 }, undefined, undefined, { cwd: dir });
		const text = extractText(result);
		assert.match(text, /Line 5 is beyond end of file \(3 lines total\)/);
		assert.match(text, /snapshotId: rev_/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("registered read preserves utf-8 characters split across stream chunks", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-read-stream-utf8-"));
	try {
		const pi = createPiStub();
		extension(pi as any);
		const read = pi.tools.get("read");
		assert.ok(read);

		const file = join(dir, "stream-utf8.txt");
		const prefix = "a".repeat(STREAM_READ_CHUNK_SIZE - 3) + "\n";
		const content = `${prefix}x你\n${"b".repeat(STREAMING_THRESHOLD)}`;
		await writeFile(file, content, "utf-8");
		const result = await read!.execute("1", { path: file, offset: 2, limit: 1 }, undefined, undefined, { cwd: dir });
		const text = extractText(result);
		assert.match(text, /^x你/m);
		assert.doesNotMatch(text, /\u0000|\uFFFD/);
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
