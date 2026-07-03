import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyHashlineEdits,
	generateStructuredPatch,
	formatStructuredPatch,
	generateDiffStringFromPatch,
	parseHashline,
	validateEditInput,
	verifyHashline,
	registerEditTool,
	collectChangedRanges,
} from "../extensions/edit.ts";

import { editIo } from "../extensions/edit.ts";
import { executeRead } from "../extensions/read.ts";
import { executeWrite } from "../extensions/write.ts";
import { getDocumentLineSnapshot, getDocumentSnapshot, shortHash } from "../extensions/shared.ts";
import { executeFindNative } from "../extensions/find.ts";
import { executeGrepNative } from "../extensions/grep.ts";
import { clearBashSessions, executeBashNative, getBashSessionCount } from "../extensions/bash.ts";

function extractText(result: { content: Array<{ type: string; text: string }> }): string {
	return result.content.map((item) => item.text).join("\n");
}


function captureToolErrorCode(error: unknown): string | undefined {
	if (!(error instanceof Error)) return undefined;
	const match = error.message.match(/"code":"([^"]+)"/);
	return match?.[1];
}

test("parseHashline parses valid anchor", () => {
	assert.deepEqual(parseHashline("42:deadbeef"), { line: 42, hash: "deadbeef" });
	assert.equal(parseHashline("42:deadbee"), null);
	assert.equal(parseHashline("bad-anchor"), null);
});

test("verifyHashline matches current content", () => {
	const line = "const x = 1;";
	assert.equal(verifyHashline(line, shortHash(line)), true);
	assert.equal(verifyHashline(line, shortHash("const x = 2;")), false);
});

test("applyHashlineEdits replaces whole line", () => {
	const content = "a\nb\nc";
	const result = applyHashlineEdits(content, [{ hashline: `2:${shortHash("b")}`, newText: "B" }], "a.txt");
	assert.equal(result, "a\nB\nc");
});

test("applyHashlineEdits inserts after anchored line", () => {
	const content = "a\nb\nc";
	const result = applyHashlineEdits(
		content,
		[{ hashline: `2:${shortHash("b")}`, newText: "inserted", wholeLine: false }],
		"a.txt",
	);
	assert.equal(result, "a\nb\ninserted\nc");
});

test("applyHashlineEdits rejects hash mismatch", () => {
	assert.throws(
		() => applyHashlineEdits("a\nb", [{ hashline: "2:deadbeef", newText: "B" }], "a.txt"),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /^TOOL_ERROR /);
			assert.match(error.message, /"code":"hashline_mismatch"/);
			assert.match(error.message, /hashline mismatch/);
			return true;
		},
	);
});


test("applyHashlineEdits rejects invalid hashline format", () => {
	assert.throws(
		() => applyHashlineEdits("a\nb", [{ hashline: "line-2", newText: "B" }], "a.txt"),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /"code":"invalid_hashline_format"/);
			return true;
		},
	);
});

test("applyHashlineEdits rejects out-of-range hashlines", () => {
	assert.throws(
		() => applyHashlineEdits("a\nb", [{ hashline: `3:${shortHash("")}`, newText: "B" }], "a.txt"),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /"code":"hashline_out_of_range"/);
			return true;
		},
	);
});

test("applyHashlineEdits rejects duplicate targets in one batch", () => {
	assert.throws(
		() =>
			applyHashlineEdits(
				"a\nb\nc",
				[
					{ hashline: `2:${shortHash("b")}`, newText: "B" },
					{ hashline: `2:${shortHash("b")}`, newText: "inserted", wholeLine: false },
				],
				"a.txt",
			),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.match(error.message, /"code":"duplicate_hashline_target"/);
			return true;
		},
	);
});

test("applyHashlineEdits verifies all anchors against the original snapshot", () => {
	const content = "a\nb\nc";
	const result = applyHashlineEdits(
		content,
		[
			{ hashline: `2:${shortHash("b")}`, newText: "inserted", wholeLine: false },
			{ hashline: `3:${shortHash("c")}`, newText: "C" },
		],
		"a.txt",
	);
	assert.equal(result, "a\nb\ninserted\nC");
});

test("applyHashlineEdits supports multi-line replacement and insertion", () => {
	const content = "a\nb\nc";
	const replaced = applyHashlineEdits(content, [{ hashline: `2:${shortHash("b")}`, newText: "B1\nB2" }], "a.txt");
	assert.equal(replaced, "a\nB1\nB2\nc");

	const inserted = applyHashlineEdits(
		content,
		[{ hashline: `2:${shortHash("b")}`, newText: "i1\ni2", wholeLine: false }],
		"a.txt",
	);
	assert.equal(inserted, "a\nb\ni1\ni2\nc");
});

test("generateDiffStringFromPatch and generateStructuredPatch report changed line", () => {
	const oldContent = "line1\nline2\nline3";
	const newContent = "line1\nline2\nchanged";
	const patch = generateStructuredPatch("file.txt", oldContent, newContent);
	const diff = generateDiffStringFromPatch(patch);
	assert.equal(diff.firstChangedLine, 3);
	assert.match(diff.diff, /-3 line3/);
	assert.match(diff.diff, /\+3 changed/);
	const formatted = formatStructuredPatch(patch);
	assert.match(formatted, /--- file.txt/);
	assert.match(formatted, /\+\+\+ file.txt/);
});

test("generateDiffStringFromPatch collapses large unchanged regions instead of showing untouched code", () => {
	const oldLines = ["start", ...Array.from({ length: 20 }, (_, i) => `keep-${i + 1}`), "before-end", "tail"];
	const newLines = [...oldLines];
	newLines[newLines.length - 2] = "changed-before-end";

	const patch = generateStructuredPatch("file", oldLines.join("\n"), newLines.join("\n"));
	const diff = generateDiffStringFromPatch(patch);
	assert.match(diff.diff, /\.\.\./);
	assert.doesNotMatch(diff.diff, /keep-1\n keep-2\n keep-3\n keep-4\n keep-5\n keep-6/);
	assert.match(diff.diff, /changed-before-end/);
});

test("collectChangedRanges truncates large windows for model reuse", () => {
	const oldContent = ["a", "b", "c", "d"].join("\n");
	const newContent = ["a", ...Array.from({ length: 20 }, (_, i) => `insert-${i + 1}`), "b", "c", "d"].join("\n");
	const ranges = collectChangedRanges(oldContent, newContent);
	assert.equal(ranges.length, 1);
	assert.equal(ranges[0]?.hashlines.length, 12);
	assert.equal(ranges[0]?.truncated, true);
});

test("edit rejects repeated identical no-op edits", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-noop-"));
	try {
		const file = join(dir, "noop.txt");
		await writeFile(file, "alpha\n", "utf-8");
		let editDef: any;
		registerEditTool({
			registerTool(def: any) {
				editDef = def;
			},
		} as any);
		for (let attempt = 1; attempt <= 3; attempt++) {
			await assert.rejects(
				editDef.execute(
					"1",
					{ path: file, edits: [{ hashline: `1:${shortHash("alpha")}`, newText: "alpha" }] },
					undefined,
					undefined,
					{ cwd: dir },
				),
				(error: unknown) => {
					assert.ok(error instanceof Error);
					assert.match(error.message, /^TOOL_ERROR /);
					assert.match(error.message, attempt >= 3 ? /"code":"noop_edit_loop"/ : /"code":"noop_edit"/);
					return true;
				},
			);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("edit verifies on-disk bytes after write", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-verify-"));
	try {
		const file = join(dir, "verify.txt");
		await writeFile(file, "alpha beta\n", "utf-8");
		let editDef: any;
		registerEditTool({
			registerTool(def: any) {
				editDef = def;
			},
		} as any);
		await editDef.execute(
			"1",
			{ path: file, edits: [{ hashline: `1:${shortHash("alpha beta")}`, newText: "alpha delta" }] },
			undefined,
			undefined,
			{ cwd: dir },
		);
		assert.equal(await readFile(file, "utf-8"), "alpha delta\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});


test("edit returns verification_failed when written file cannot be re-read", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-verify-reread-"));
	const originalReadFile = editIo.readFile;
	try {
		const file = join(dir, "verify-reread.txt");
		await writeFile(file, "alpha beta\n", "utf-8");
		let fileReadCount = 0;
		const readMock = t.mock.method(editIo, "readFile", async (path: string) => {
			if (String(path) === file && ++fileReadCount > 1) {
				const err = new Error("boom") as NodeJS.ErrnoException;
				err.code = "EIO";
				throw err;
			}
			return originalReadFile(path);
		});

		let editDef: any;
		registerEditTool({
			registerTool(def: any) {
				editDef = def;
			},
		} as any);
		await assert.rejects(
			editDef.execute(
				"1",
				{ path: file, edits: [{ hashline: `1:${shortHash("alpha beta")}`, newText: "alpha delta" }] },
				undefined,
				undefined,
				{ cwd: dir },
			),
			(error: unknown) => {
				assert.equal(captureToolErrorCode(error), "verification_failed");
				assert.match((error as Error).message, /failed to re-read the file/);
				return true;
			},
		);
		assert.equal(fileReadCount, 2);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("edit returns verification_failed when disk content differs after write", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-verify-mismatch-"));
	const originalReadFile = editIo.readFile;
	try {
		const file = join(dir, "verify-mismatch.txt");
		await writeFile(file, "alpha beta\n", "utf-8");
		let fileReadCount = 0;
		t.mock.method(editIo, "readFile", async (path: string) => {
			if (String(path) === file && ++fileReadCount > 1) return Buffer.from("corrupted\n", "utf-8");
			return originalReadFile(path);
		});

		let editDef: any;
		registerEditTool({
			registerTool(def: any) {
				editDef = def;
			},
		} as any);
		await assert.rejects(
			editDef.execute(
				"1",
				{ path: file, edits: [{ hashline: `1:${shortHash("alpha beta")}`, newText: "alpha delta" }] },
				undefined,
				undefined,
				{ cwd: dir },
			),
			(error: unknown) => {
				assert.equal(captureToolErrorCode(error), "verification_failed");
				assert.match((error as Error).message, /disk content differs/);
				return true;
			},
		);
	} finally {
		assert.equal(typeof fileReadCount === "number" ? fileReadCount : 2, 2);
		await rm(dir, { recursive: true, force: true });
	}
});

test("edit requests refresh when stale hashline cannot be safely rebased", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-refresh-"));
	try {
		const file = join(dir, "refresh.txt");
		await writeFile(file, "first\nsecond\nthird\n", "utf-8");
		const readResult = await executeRead(file, undefined, undefined, true, undefined, dir);
		const revisionId = (readResult.details as { revisionId?: string } | undefined)?.revisionId;
		assert.ok(revisionId);
		const thirdHashline = extractText(readResult)
			.split("\n")
			.find((line) => line.includes("|third"))
			?.split("|", 2)[0];
		assert.ok(thirdHashline);
		await writeFile(file, "first\nsecond\nchanged externally\n", "utf-8");

		let editDef: any;
		registerEditTool({
			registerTool(def: any) {
				editDef = def;
			},
		} as any);
		await assert.rejects(
			editDef.execute(
				"1",
				{ path: file, baseRevisionId: revisionId, edits: [{ hashline: thirdHashline, newText: "THIRD" }] },
				undefined,
				undefined,
				{ cwd: dir },
			),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /"code":"needs_refresh"/);
				return true;
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});


test("edit rebases stale hashline using surrounding context when content is duplicated", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-rebase-context-"));
	try {
		const file = join(dir, "rebase-context.txt");
		await writeFile(file, "alpha\ntarget\nomega\nalpha\ntarget\nbeta\n", "utf-8");
		const readResult = await executeRead(file, undefined, undefined, true, undefined, dir);
		const revisionId = (readResult.details as { revisionId?: string } | undefined)?.revisionId;
		assert.ok(revisionId);
		const targetHashline = extractText(readResult)
			.split("\n")
			.find((line) => line.startsWith("2:") && line.includes("|target"))
			?.split("|", 2)[0];
		assert.ok(targetHashline);
		await writeFile(file, "intro\nalpha\ntarget\nomega\nalpha\ntarget\nbeta\n", "utf-8");

		let editDef: any;
		registerEditTool({
			registerTool(def: any) {
				editDef = def;
			},
		} as any);
		const result = await editDef.execute(
			"1",
			{ path: file, baseRevisionId: revisionId, edits: [{ hashline: targetHashline, newText: "TARGET" }] },
			undefined,
			undefined,
			{ cwd: dir },
		);
		assert.match(extractText(result), /automatic rebase/);
		assert.equal(await readFile(file, "utf-8"), "intro\nalpha\nTARGET\nomega\nalpha\ntarget\nbeta\n");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("edit requests refresh when duplicated content stays ambiguous after rebase", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-rebase-ambiguous-"));
	try {
		const file = join(dir, "rebase-ambiguous.txt");
		await writeFile(file, "alpha\ntarget\nomega\nalpha\ntarget\nomega\n", "utf-8");
		const readResult = await executeRead(file, undefined, undefined, true, undefined, dir);
		const revisionId = (readResult.details as { revisionId?: string } | undefined)?.revisionId;
		assert.ok(revisionId);
		const targetHashline = extractText(readResult)
			.split("\n")
			.find((line) => line.startsWith("2:") && line.includes("|target"))
			?.split("|", 2)[0];
		assert.ok(targetHashline);
		await writeFile(file, "intro\nalpha\ntarget\nomega\nalpha\ntarget\nomega\n", "utf-8");

		let editDef: any;
		registerEditTool({
			registerTool(def: any) {
				editDef = def;
			},
		} as any);
		await assert.rejects(
			editDef.execute(
				"1",
				{ path: file, baseRevisionId: revisionId, edits: [{ hashline: targetHashline, newText: "TARGET" }] },
				undefined,
				undefined,
				{ cwd: dir },
			),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /"code":"needs_refresh"/);
				return true;
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("edit rebases from streaming line snapshots when full snapshot is unavailable", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-stream-snapshot-"));
	try {
		const file = join(dir, "stream-snapshot.txt");
		const content = Array.from({ length: 600000 }, (_, i) => (i === 2 ? "target" : `line-${i + 1}`)).join("\n") + "\n";
		await writeFile(file, content, "utf-8");
		const readResult = await executeRead(file, 1, 3, true, undefined, dir);
		const revisionId = (readResult.details as { revisionId?: string } | undefined)?.revisionId;
		assert.ok(revisionId);
		assert.equal(getDocumentSnapshot(file, revisionId), undefined);
		assert.equal(getDocumentLineSnapshot(file, revisionId, 3), "target");
		const targetHashline = extractText(readResult)
			.split("\n")
			.find((line) => line.startsWith("3:") && line.includes("|target"))
			?.split("|", 2)[0];
		assert.ok(targetHashline);
		await writeFile(file, `intro\n${content}`, "utf-8");

		let editDef: any;
		registerEditTool({
			registerTool(def: any) {
				editDef = def;
			},
		} as any);
		const result = await editDef.execute(
			"1",
			{ path: file, baseRevisionId: revisionId, edits: [{ hashline: targetHashline, newText: "TARGET" }] },
			undefined,
			undefined,
			{ cwd: dir },
		);
		assert.match(extractText(result), /automatic rebase/);
		const finalContent = await readFile(file, "utf-8");
		assert.match(finalContent, /^intro\nline-1\nline-2\nTARGET\n/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("edit returns file_not_found for missing files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-missing-"));
	try {
		let editDef: any;
		registerEditTool({
			registerTool(def: any) {
				editDef = def;
			},
		} as any);
		await assert.rejects(
			editDef.execute(
				"1",
				{ path: join(dir, "missing.txt"), edits: [{ hashline: `1:${shortHash("")}`, newText: "x" }] },
				undefined,
				undefined,
				{ cwd: dir },
			),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /"code":"file_not_found"/);
				return true;
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("edit returns read_failed for directory paths", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-read-failed-"));
	try {
		const target = join(dir, "not-a-file");
		await mkdir(target);

		let editDef: any;
		registerEditTool({
			registerTool(def: any) {
				editDef = def;
			},
		} as any);
		await assert.rejects(
			editDef.execute(
				"1",
				{ path: target, edits: [{ hashline: `1:${shortHash("")}`, newText: "x" }] },
				undefined,
				undefined,
				{ cwd: dir },
			),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /"code":"read_failed"/);
				return true;
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});


test("edit returns permission_denied when initial read gets EACCES", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-read-eacces-"));
	const originalReadFile = editIo.readFile;
	try {
		const file = join(dir, "read-eacces.txt");
		await writeFile(file, "alpha\n", "utf-8");
		t.mock.method(editIo, "readFile", async (path: string) => {
			if (String(path) === file) {
				const err = new Error("denied") as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			}
			return originalReadFile(path);
		});

		let editDef: any;
		registerEditTool({
			registerTool(def: any) {
				editDef = def;
			},
		} as any);
		await assert.rejects(
			editDef.execute(
				"1",
				{ path: file, edits: [{ hashline: `1:${shortHash("alpha")}`, newText: "beta" }] },
				undefined,
				undefined,
				{ cwd: dir },
			),
			(error: unknown) => {
				assert.equal(captureToolErrorCode(error), "permission_denied");
				return true;
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("edit returns permission_denied_write when write gets EACCES", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-write-eacces-"));
	const originalWriteFile = editIo.writeFile;
	try {
		const file = join(dir, "write-eacces.txt");
		await writeFile(file, "alpha\n", "utf-8");
		t.mock.method(editIo, "writeFile", async (path: string, content: string) => {
			if (String(path) === file) {
				const err = new Error("denied") as NodeJS.ErrnoException;
				err.code = "EACCES";
				throw err;
			}
			return originalWriteFile(path, content);
		});

		let editDef: any;
		registerEditTool({
			registerTool(def: any) {
				editDef = def;
			},
		} as any);
		await assert.rejects(
			editDef.execute(
				"1",
				{ path: file, edits: [{ hashline: `1:${shortHash("alpha")}`, newText: "beta" }] },
				undefined,
				undefined,
				{ cwd: dir },
			),
			(error: unknown) => {
				assert.equal(captureToolErrorCode(error), "permission_denied_write");
				return true;
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("edit returns disk_full when write gets ENOSPC", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-edit-write-enospc-"));
	const originalWriteFile = editIo.writeFile;
	try {
		const file = join(dir, "write-enospc.txt");
		await writeFile(file, "alpha\n", "utf-8");
		t.mock.method(editIo, "writeFile", async (path: string, content: string) => {
			if (String(path) === file) {
				const err = new Error("full") as NodeJS.ErrnoException;
				err.code = "ENOSPC";
				throw err;
			}
			return originalWriteFile(path, content);
		});

		let editDef: any;
		registerEditTool({
			registerTool(def: any) {
				editDef = def;
			},
		} as any);
		await assert.rejects(
			editDef.execute(
				"1",
				{ path: file, edits: [{ hashline: `1:${shortHash("alpha")}`, newText: "beta" }] },
				undefined,
				undefined,
				{ cwd: dir },
			),
			(error: unknown) => {
				assert.equal(captureToolErrorCode(error), "disk_full");
				return true;
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
test("validateEditInput accepts hashline edits", () => {
	const validated = validateEditInput({
		path: "a.txt",
		edits: [
			{ hashline: `1:${shortHash("x")}`, newText: "y" },
		],
	});
	assert.equal(validated.edits.length, 1);
	assert.equal(validated.edits[0]!.hashline, `1:${shortHash("x")}`);
});
test("validateEditInput rejects edits without hashline", () => {
	assert.throws(
		() =>
			validateEditInput({
				path: "a.txt",
				edits: [{ newText: "b" }],
			}),
		/missing_hashline/,
	);
});


test("validateEditInput rejects empty edit batches", () => {
	assert.throws(
		() => validateEditInput({ path: "a.txt", edits: [] }),
		/invalid_input/,
	);
});
test("executeRead reads offset/limit and hashlines", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-read-"));
	try {
		const file = join(dir, "sample.txt");
		await writeFile(file, "one\ntwo\nthree\nfour\n", "utf-8");
		const result = await executeRead(file, 2, 2, true, undefined, dir);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /^2:[a-f0-9]{8}\|two/m);
		assert.match(text, /^3:[a-f0-9]{8}\|three/m);
		assert.match(text, /more lines in file|truncated|Showing lines/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead supports explicit ranges with context", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-read-ranges-"));
	try {
		const file = join(dir, "sample.txt");
		await writeFile(file, Array.from({ length: 12 }, (_, i) => `line-${i + 1}`).join("\n"), "utf-8");
		const result = await executeRead(
			file,
			undefined,
			undefined,
			false,
			undefined,
			dir,
			[
				{ start: 3, end: 4, before: 1, after: 1 },
				{ start: 9, end: 10, before: 1, after: 0 },
			],
		);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /\[lines 2-5 \| requested lines 3-4 \| context -1\/\+1\]/);
		assert.match(text, /2\|line-2/);
		assert.match(text, /5\|line-5/);
		assert.match(text, /\[lines 8-10 \| requested lines 9-10 \| context -1\/\+0\]/);
		assert.match(text, /8\|line-8/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead merges overlapping ranges", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-read-ranges-merge-"));
	try {
		const file = join(dir, "sample.txt");
		await writeFile(file, Array.from({ length: 8 }, (_, i) => `line-${i + 1}`).join("\n"), "utf-8");
		const result = await executeRead(
			file,
			undefined,
			undefined,
			false,
			undefined,
			dir,
			[
				{ start: 3, end: 4, after: 1 },
				{ start: 5, end: 5 },
			],
		);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /merged requests: lines 3-4, line 5/);
		assert.match(text, /3\|line-3/);
		assert.match(text, /5\|line-5/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead rejects binary files with NUL bytes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-read-binary-"));
	try {
		const file = join(dir, "sample.bin");
		await writeFile(file, Buffer.from([0x41, 0x00, 0x42]));
		await assert.rejects(
			executeRead(file, undefined, undefined, false, undefined, dir),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /^TOOL_ERROR /);
				assert.match(error.message, /"code":"binary_file"/);
				return true;
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead includes a stable trailing empty line in hashline mode", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-read-trailing-"));
	try {
		const file = join(dir, "sample.txt");
		await writeFile(file, "one\ntwo\n", "utf-8");
		const result = await executeRead(file, 1, undefined, true, undefined, dir);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /^1:[a-f0-9]{8}\|one/m);
		assert.match(text, /^2:[a-f0-9]{8}\|two/m);
		assert.match(text, /^3:[a-f0-9]{8}\|$/m);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead returns recoverable guidance for offset out of range", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-read-oob-"));
	try {
		const file = join(dir, "sample.txt");
		await writeFile(file, "one\ntwo\n", "utf-8");
		const result = await executeRead(file, 99, undefined, false, undefined, dir);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /Line 99 is beyond end of file \(3 lines total\)/);
		assert.match(text, /Use offset=1 to read from the start/);
		assert.ok((result.details as { revisionId?: string } | undefined)?.revisionId);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeWrite writes and verifies small file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-write-small-"));
	try {
		const file = join(dir, "out.txt");
		const result = await executeWrite(file, "hello small write", undefined, dir);
		const written = await readFile(file, "utf-8");
		assert.equal(written, "hello small write");
		assert.equal(result.details?.size, Buffer.byteLength("hello small write", "utf-8"));
		assert.match(result.content[0]?.text ?? "", /Successfully wrote/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeWrite strips hashline display prefixes before writing", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-write-hashline-strip-"));
	try {
		const file = join(dir, "stripped.txt");
		const result = await executeWrite(
			file,
			"[stripped.txt#deadbeef]\n1:11111111|alpha\n2:22222222|beta",
			undefined,
			dir,
		);
		const written = await readFile(file, "utf-8");
		assert.equal(written, "alpha\nbeta");
		assert.match(result.content[0]?.text ?? "", /auto-stripped hashline display prefixes/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeWrite marks shebang script executable on unix", async () => {
	if (process.platform === "win32") return;
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-write-shebang-"));
	try {
		const file = join(dir, "tool.sh");
		const result = await executeWrite(file, "#!/bin/sh\necho hi\n", undefined, dir);
		const stats = await statMode(file);
		assert.equal((stats & 0o111) !== 0, true);
		assert.match(result.content[0]?.text ?? "", /marked shebang file as executable/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeWrite writes and verifies large streaming file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-write-large-"));
	try {
		const file = join(dir, "large.txt");
		const content = "0123456789abcdef\n".repeat(400000);
		assert.ok(Buffer.byteLength(content, "utf-8") > 5 * 1024 * 1024);
		const result = await executeWrite(file, content, undefined, dir);
		const stats = await readFile(file, "utf-8");
		assert.equal(stats.length, content.length);
		assert.equal(result.details?.size, Buffer.byteLength(content, "utf-8"));
		assert.match(result.content[0]?.text ?? "", /via streaming/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeWrite streams large unicode content without splitting surrogate pairs", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-write-large-unicode-"));
	try {
		const file = join(dir, "large-unicode.txt");
		const content = "😀0123456789abcdef\n".repeat(350000);
		const contentBytes = Buffer.byteLength(content, "utf-8");
		assert.ok(contentBytes > 5 * 1024 * 1024);
		const result = await executeWrite(file, content, undefined, dir);
		const written = await readFile(file, "utf-8");
		assert.equal(written, content);
		assert.equal(result.details?.size, contentBytes);
		assert.match(result.content[0]?.text ?? "", /via streaming/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead streams large file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-stream-read-"));
	try {
		const file = join(dir, "large-read.txt");
		const content = "line\n".repeat(1400000);
		assert.ok(Buffer.byteLength(content, "utf-8") > 5 * 1024 * 1024);
		await writeFile(file, content, "utf-8");
		const result = await executeRead(file, 10, 3, false, undefined, dir);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /^line/m);
		assert.match(text, /Streaming read/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead streams disjoint ranges from large files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-stream-read-ranges-"));
	try {
		const file = join(dir, "large-read-ranges.txt");
		const content = Array.from({ length: 600000 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
		assert.ok(Buffer.byteLength(content, "utf-8") > 5 * 1024 * 1024);
		await writeFile(file, content, "utf-8");
		const result = await executeRead(
			file,
			undefined,
			undefined,
			false,
			undefined,
			dir,
			[
				{ start: 100, end: 101, before: 1, after: 1 },
				{ start: 500000, end: 500001 },
			],
		);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /99\|line-99/);
		assert.match(text, /100\|line-100/);
		assert.match(text, /500000\|line-500000/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead stops large streaming reads at the default line limit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-stream-read-default-"));
	try {
		const file = join(dir, "large-read-default.txt");
		const content = "line\n".repeat(1400000);
		await writeFile(file, content, "utf-8");
		const result = await executeRead(file, undefined, undefined, false, undefined, dir);
		const text = result.content[0]?.text ?? "";
		assert.match(text, /Streaming read: showing lines 1-\d+ of approx/);
		assert.match(text, /Use offset=\d+ to continue/);
		assert.doesNotMatch(text, /Streaming read complete/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeFindNative uses native glob and returns relative paths", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-find-"));
	try {
		await writeFile(join(dir, "a.ts"), "a", "utf-8");
		await writeFile(join(dir, "b.js"), "b", "utf-8");
		await writeFile(join(dir, ".hidden.ts"), "c", "utf-8");
		const result = await executeFindNative("*.ts", undefined, 10, dir, undefined);
		const text = extractText(result);
		assert.match(text, /a\.ts/);
		assert.match(text, /\.hidden\.ts/);
		assert.doesNotMatch(text, /b\.js/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeFindNative does not report result limit when total matches equal limit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-find-limit-"));
	try {
		await writeFile(join(dir, "a.ts"), "a", "utf-8");
		await writeFile(join(dir, "b.ts"), "b", "utf-8");
		const result = await executeFindNative("*.ts", undefined, 2, dir, undefined);
		assert.equal(result.details?.resultLimitReached, undefined);
		assert.doesNotMatch(extractText(result), /results limit reached/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeFindNative returns structured path_not_found errors", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-find-missing-"));
	try {
		const missing = join(dir, "missing-dir");
		await assert.rejects(
			executeFindNative("*.ts", missing, 10, dir, undefined),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /^TOOL_ERROR /);
				assert.match(error.message, /"code":"path_not_found"/);
				assert.match(error.message, /Path not found:/);
				return true;
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeWrite invalidates native scan cache", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-write-cache-"));
	try {
		await executeWrite(join(dir, "a.ts"), "const a = 1;\n", undefined, dir);
		let result = await executeFindNative("*.ts", undefined, 10, dir, undefined);
		assert.match(extractText(result), /a\.ts/);

		await executeWrite(join(dir, "b.ts"), "const b = 2;\n", undefined, dir);
		result = await executeFindNative("*.ts", undefined, 10, dir, undefined);
		const text = extractText(result);
		assert.match(text, /a\.ts/);
		assert.match(text, /b\.ts/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeWrite returns structured write_failed errors", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-write-fail-"));
	try {
		const target = join(dir, "existing-dir");
		await writeFile(join(target, ".keep"), "x", "utf-8").catch(async () => {
			await rm(target, { recursive: true, force: true });
			await executeWrite(join(target, ".keep"), "x", undefined, dir);
		});
		await assert.rejects(
			executeWrite(target, "nope", undefined, dir),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /^TOOL_ERROR /);
				assert.match(error.message, /"code":"write_failed"/);
				assert.match(error.message, /Failed to write/);
				return true;
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeGrepNative uses native grep with context", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-grep-"));
	try {
		const file = join(dir, "sample.txt");
		await writeFile(file, "zero\none\ntwo needle\nthree\n", "utf-8");
		const result = await executeGrepNative("needle", undefined, undefined, false, false, 1, 10, dir, undefined, undefined);
		const text = extractText(result);
		assert.match(text, /sample\.txt-2- one/);
		assert.match(text, /sample\.txt:3: two needle/);
		assert.match(text, /sample\.txt-4- three/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeGrepNative escapes literals", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-grep-literal-"));
	try {
		const file = join(dir, "sample.txt");
		await writeFile(file, "fetchAnthropicProvider(\nother\n", "utf-8");
		const result = await executeGrepNative("fetchAnthropicProvider(", undefined, undefined, false, true, 0, 10, dir, undefined, undefined);
		assert.match(extractText(result), /sample\.txt:1: fetchAnthropicProvider\(/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeGrepNative returns structured invalid regex errors", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-grep-invalid-regex-"));
	try {
		await writeFile(join(dir, "sample.txt"), "needle\n", "utf-8");
		await assert.rejects(
			executeGrepNative("[", undefined, undefined, false, false, 0, 10, dir, undefined, undefined),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /^TOOL_ERROR /);
				assert.match(error.message, /"code":"invalid_regex"/);
				assert.match(error.message, /Invalid regex:/);
				return true;
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeGrepNative supports count mode", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-grep-count-"));
	try {
		await writeFile(join(dir, "a.txt"), "needle\nneedle\nother\n", "utf-8");
		await writeFile(join(dir, "b.txt"), "needle\n", "utf-8");
		const result = await executeGrepNative("needle", undefined, undefined, false, false, 0, 10, dir, undefined, "count");
		const text = extractText(result);
		assert.match(text, /a\.txt: 2/);
		assert.match(text, /b\.txt: 1/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeGrepNative supports filesWithMatches mode", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-grep-files-"));
	try {
		await writeFile(join(dir, "a.txt"), "needle\nneedle\nother\n", "utf-8");
		await writeFile(join(dir, "b.txt"), "needle\n", "utf-8");
		const result = await executeGrepNative("needle", undefined, undefined, false, false, 0, 10, dir, undefined, "filesWithMatches");
		const text = extractText(result);
		assert.match(text, /a\.txt/);
		assert.match(text, /b\.txt/);
		assert.doesNotMatch(text, /: 1|: 2|needle/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeGrepNative marks linesTruncated for truncated displayed lines", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-grep-truncation-"));
	try {
		const file = join(dir, "sample.txt");
		await writeFile(file, `${"needle"}${"x".repeat(700)}\nshort\n`, "utf-8");
		const result = await executeGrepNative("needle", undefined, undefined, false, false, 0, 10, dir, undefined, undefined);
		assert.equal(result.details?.linesTruncated, true);
		assert.match(extractText(result), /Some lines truncated to 500 chars/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeBashNative preserves shell session cwd across calls", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-bash-session-"));
	try {
		const first = await executeBashNative("cd .. && pwd", dir, undefined, undefined);
		const second = await executeBashNative("pwd", dir, undefined, undefined);
		const firstText = extractText(first).trim();
		const secondText = extractText(second).trim();
		assert.equal(secondText, firstText);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeBashNative supports disabling shell sessions per command", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-bash-no-session-"));
	try {
		await executeBashNative("cd .. && pwd", dir, undefined, undefined, undefined, { session: false });
		const second = await executeBashNative("pwd", dir, undefined, undefined, undefined, { session: false });
		assert.equal(await realpath(extractText(second).trim()), await realpath(dir));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeBashNative resets shell session on demand", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-bash-reset-"));
	try {
		await executeBashNative("cd ..", dir, undefined, undefined);
		const reset = await executeBashNative("pwd", dir, undefined, undefined, undefined, { resetSession: true });
		assert.equal(await realpath(extractText(reset).trim()), await realpath(dir));
	} finally {
		clearBashSessions();
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeBashNative preserves streamed output in thrown errors", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-bash-error-"));
	try {
		await assert.rejects(
			executeBashNative("echo before-fail && exit 7", dir, undefined, undefined),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /^TOOL_ERROR /);
				assert.match(error.message, /"code":"command_failed"/);
				assert.match(error.message, /before-fail/);
				assert.match(error.message, /Command exited with code 7/);
				return true;
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeBashNative throttles progress updates", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-bash-updates-"));
	const previous = process.env.PI_NATIVE_BASH_UPDATE_THROTTLE_MS;
	try {
		process.env.PI_NATIVE_BASH_UPDATE_THROTTLE_MS = "100";
		const updates: string[] = [];
		const result = await executeBashNative(
			"for n in 1 2 3 4 5; do echo $n; sleep 0.02; done",
			dir,
			undefined,
			undefined,
			(update) => {
				updates.push(extractText(update));
			},
		);
		assert.match(extractText(result), /5/);
		assert.ok(updates.length < 6, `expected throttled updates, got ${updates.length}`);
	} finally {
		if (previous === undefined) delete process.env.PI_NATIVE_BASH_UPDATE_THROTTLE_MS;
		else process.env.PI_NATIVE_BASH_UPDATE_THROTTLE_MS = previous;
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeBashNative evicts idle shell sessions", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-bash-evict-"));
	const previous = process.env.PI_NATIVE_BASH_SESSION_IDLE_MS;
	try {
		clearBashSessions();
		process.env.PI_NATIVE_BASH_SESSION_IDLE_MS = "20";
		await executeBashNative("pwd", dir, undefined, undefined);
		assert.equal(getBashSessionCount(), 1);
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(getBashSessionCount(), 0);
	} finally {
		clearBashSessions();
		if (previous === undefined) delete process.env.PI_NATIVE_BASH_SESSION_IDLE_MS;
		else process.env.PI_NATIVE_BASH_SESSION_IDLE_MS = previous;
		await rm(dir, { recursive: true, force: true });
	}
});

async function statMode(path: string): Promise<number> {
	const { stat } = await import("node:fs/promises");
	return (await stat(path)).mode;
}
