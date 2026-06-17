import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyHashlineEdits,
	applyTextEdits,
	generateDiffString,
	generatePatch,
	parseHashline,
	prepareEditArguments,
	validateEditInput,
	verifyHashline,
} from "../extensions/edit.ts";
import { executeRead } from "../extensions/read.ts";
import { executeWrite } from "../extensions/write.ts";
import { shortHash } from "../extensions/shared.ts";

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

test("applyTextEdits replaces unique exact match", () => {
	const result = applyTextEdits("hello world", [{ oldText: "world", newText: "pi" }], "a.txt");
	assert.equal(result, "hello pi");
});

test("applyTextEdits rejects non-unique match", () => {
	assert.throws(
		() => applyTextEdits("x\ny\nx", [{ oldText: "x", newText: "z" }], "a.txt"),
		/appears multiple times/,
	);
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
		/hashline mismatch/,
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

test("generateDiffString and generatePatch report changed line", () => {
	const oldContent = "line1\nline2\nline3";
	const newContent = "line1\nline2\nchanged";
	const diff = generateDiffString(oldContent, newContent);
	assert.equal(diff.firstChangedLine, 3);
	assert.match(diff.diff, /-3 line3/);
	assert.match(diff.diff, /\+3 changed/);
	const patch = generatePatch("file.txt", oldContent, newContent);
	assert.match(patch, /--- file.txt/);
	assert.match(patch, /\+\+\+ file.txt/);
});

test("generateDiffString collapses large unchanged regions instead of showing untouched code", () => {
	const oldLines = ["start", ...Array.from({ length: 20 }, (_, i) => `keep-${i + 1}`), "before-end", "tail"];
	const newLines = [...oldLines];
	newLines[newLines.length - 2] = "changed-before-end";

	const diff = generateDiffString(oldLines.join("\n"), newLines.join("\n"));
	assert.match(diff.diff, /\.\.\./);
	assert.doesNotMatch(diff.diff, /keep-1\n keep-2\n keep-3\n keep-4\n keep-5\n keep-6/);
	assert.match(diff.diff, /changed-before-end/);
});

test("prepareEditArguments supports legacy flat format and JSON string edits", () => {
	const legacy = prepareEditArguments({ path: "a.txt", oldText: "a", newText: "b" });
	assert.deepEqual(legacy, { path: "a.txt", edits: [{ oldText: "a", newText: "b" }] });

	const jsonEdits = prepareEditArguments({ path: "a.txt", edits: '[{"oldText":"a","newText":"b"}]' });
	assert.deepEqual(jsonEdits, { path: "a.txt", edits: [{ oldText: "a", newText: "b" }] });
});

test("validateEditInput separates text and hashline edits", () => {
	const validated = validateEditInput({
		path: "a.txt",
		edits: [
			{ oldText: "a", newText: "b" },
			{ hashline: `1:${shortHash("x")}`, newText: "y" },
		],
	});
	assert.equal(validated.textEdits.length, 1);
	assert.equal(validated.hashlineEdits.length, 1);
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
