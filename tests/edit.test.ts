import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeEdit, registerEditTool } from "../extensions/edit.ts";
import { executeRead } from "../extensions/read.ts";

function extractText(result: { content: Array<{ type: string; text: string }> }): string {
	return result.content.map((item) => item.text).join("\n");
}

test("executeEdit applies exact replacement with snapshotId", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-unit-"));
	try {
		const file = join(dir, "demo.txt");
		await writeFile(file, "alpha beta gamma\n", "utf-8");
		const readResult = await executeRead(file, 1, 1, undefined, dir, undefined, undefined, true);
		const snapshotId = (readResult.details as { snapshotId?: string } | undefined)?.snapshotId;
		assert.ok(snapshotId);

		const result = await executeEdit(file, snapshotId, [{ oldText: "alpha beta gamma", newText: "alpha delta gamma" }], false, undefined, dir);
		assert.equal(result.details.status, "applied");
		assert.equal(result.details.appliedCount, 1);
		assert.match(extractText(result), /Applied 1 replacement/);
		assert.equal(await readFile(file, "utf-8"), "alpha delta gamma\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeEdit returns ambiguous when oldText matches more than once", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-ambiguous-unit-"));
	try {
		const file = join(dir, "demo.txt");
		await writeFile(file, "repeat\nrepeat\n", "utf-8");
		const result = await executeEdit(file, undefined, [{ oldText: "repeat", newText: "done" }], false, undefined, dir);
		assert.equal(result.details.status, "conflict");
		assert.equal(result.details.reason, "ambiguous");
		assert.ok(result.details.candidates?.length);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeEdit returns stale_snapshot after external change", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-stale-unit-"));
	try {
		const file = join(dir, "demo.txt");
		await writeFile(file, "before\n", "utf-8");
		const readResult = await executeRead(file, 1, 1, undefined, dir, undefined, undefined, true);
		const snapshotId = (readResult.details as { snapshotId?: string } | undefined)?.snapshotId;
		assert.ok(snapshotId);
		await writeFile(file, "after\n", "utf-8");

		const result = await executeEdit(file, snapshotId, [{ oldText: "before", newText: "done" }], false, undefined, dir);
		assert.equal(result.details.status, "conflict");
		assert.equal(result.details.reason, "stale_snapshot");
		assert.ok(result.details.latestSnapshotId);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeEdit rejects stale snapshot even when oldText still exists", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-stale-existing-unit-"));
	try {
		const file = join(dir, "demo.txt");
		await writeFile(file, "before keep\n", "utf-8");
		const readResult = await executeRead(file, 1, 1, undefined, dir, undefined, undefined, true);
		const snapshotId = (readResult.details as { snapshotId?: string } | undefined)?.snapshotId;
		assert.ok(snapshotId);
		await writeFile(file, "changed before keep\n", "utf-8");

		const result = await executeEdit(file, snapshotId, [{ oldText: "before", newText: "done" }], false, undefined, dir);
		assert.equal(result.details.status, "conflict");
		assert.equal(result.details.reason, "stale_snapshot");
		assert.equal(await readFile(file, "utf-8"), "changed before keep\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeEdit supports replaceAll", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-all-unit-"));
	try {
		const file = join(dir, "demo.txt");
		await writeFile(file, "x repeat y repeat z", "utf-8");
		const result = await executeEdit(file, undefined, [{ oldText: "repeat", newText: "done" }], true, undefined, dir);
		assert.equal(result.details.status, "applied");
		assert.equal(result.details.appliedCount, 2);
		assert.equal(await readFile(file, "utf-8"), "x done y done z");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeEdit applies batch edits from edits[] in one call", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-batch-unit-"));
	try {
		const file = join(dir, "demo.txt");
		await writeFile(file, "aaa\nbbb\nccc\nddd\n", "utf-8");
		const result = await executeEdit(file, undefined, [
			{ oldText: "aaa", newText: "111" },
			{ oldText: "ccc", newText: "333" },
		], false, undefined, dir);
		assert.equal(result.details.status, "applied");
		assert.equal(result.details.appliedCount, 2);
		assert.equal(await readFile(file, "utf-8"), "111\nbbb\n333\nddd\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeEdit returns conflict for overlapping batch edits", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-overlap-unit-"));
	try {
		const file = join(dir, "demo.txt");
		await writeFile(file, "hello world\n", "utf-8");
		const result = await executeEdit(file, undefined, [
			{ oldText: "hello world", newText: "a" },
			{ oldText: "world", newText: "b" },
		], false, undefined, dir);
		assert.equal(result.details.status, "conflict");
		assert.equal(result.details.reason, "overlap");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeEdit returns conflict for not_found in batch edit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-batch-404-unit-"));
	try {
		const file = join(dir, "demo.txt");
		await writeFile(file, "hello\n", "utf-8");
		const result = await executeEdit(file, undefined, [
			{ oldText: "hello", newText: "hi" },
			{ oldText: "nope", newText: "yes" },
		], false, undefined, dir);
		assert.equal(result.details.status, "conflict");
		assert.equal(result.details.reason, "not_found");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("registerEditTool rejects mixed legacy and batch params", async () => {
	let execute: ((
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
		ctx: { cwd: string },
	) => Promise<unknown>) | undefined;
	registerEditTool({
		registerTool(def: { execute: typeof execute }) {
			execute = def.execute;
		},
	} as any);
	assert.ok(execute);
	await assert.rejects(
		() => execute!("1", {
			path: "demo.txt",
			oldText: "a",
			newText: "b",
			edits: [{ oldText: "c", newText: "d" }],
		}, undefined, undefined, { cwd: process.cwd() }),
		/do not combine edits\[\] with oldText\/newText/,
	);
});


test("registerEditTool rejects empty oldText in legacy mode", async () => {
	let execute: ((
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
		ctx: { cwd: string },
	) => Promise<unknown>) | undefined;
	registerEditTool({
		registerTool(def: { execute: typeof execute }) {
			execute = def.execute;
		},
	} as any);
	assert.ok(execute);
	await assert.rejects(
		() => execute!("1", {
			path: "demo.txt",
			oldText: "",
			newText: "b",
		}, undefined, undefined, { cwd: process.cwd() }),
		/oldText must be a non-empty string/,
	);
});
