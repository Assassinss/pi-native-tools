import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeEdit } from "../extensions/edit.ts";
import { executeRead } from "../extensions/read.ts";

function extractText(result: { content: Array<{ type: string; text: string }> }): string {
	return result.content.map((item) => item.text).join("\n");
}

test("executeEdit applies exact replacement with snapshotId", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-unit-"));
	try {
		const file = join(dir, "demo.txt");
		await writeFile(file, "alpha beta gamma\n", "utf-8");
		const readResult = await executeRead(file, 1, 1, undefined, dir);
		const snapshotId = (readResult.details as { snapshotId?: string } | undefined)?.snapshotId;
		assert.ok(snapshotId);

		const result = await executeEdit(file, snapshotId, "alpha beta gamma", "alpha delta gamma", undefined, undefined, dir);
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
		const result = await executeEdit(file, undefined, "repeat", "done", undefined, undefined, dir);
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
		const readResult = await executeRead(file, 1, 1, undefined, dir);
		const snapshotId = (readResult.details as { snapshotId?: string } | undefined)?.snapshotId;
		assert.ok(snapshotId);
		await writeFile(file, "after\n", "utf-8");

		const result = await executeEdit(file, snapshotId, "before", "done", undefined, undefined, dir);
		assert.equal(result.details.status, "conflict");
		assert.equal(result.details.reason, "stale_snapshot");
		assert.ok(result.details.latestSnapshotId);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeEdit supports replaceAll", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-all-unit-"));
	try {
		const file = join(dir, "demo.txt");
		await writeFile(file, "x repeat y repeat z", "utf-8");
		const result = await executeEdit(file, undefined, "repeat", "done", true, undefined, dir);
		assert.equal(result.details.status, "applied");
		assert.equal(result.details.appliedCount, 2);
		assert.equal(await readFile(file, "utf-8"), "x done y done z");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
