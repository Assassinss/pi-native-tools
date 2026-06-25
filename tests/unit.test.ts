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
import { executeFindNative } from "../extensions/find.ts";
import { executeGrepNative } from "../extensions/grep.ts";
import { clearBashSessions, executeBashNative, getBashSessionCount } from "../extensions/bash.ts";

function extractText(result: { content: Array<{ type: string; text: string }> }): string {
	return result.content.map((item) => item.text).join("\n");
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

test("applyTextEdits resolves all matches against the original content", () => {
	const result = applyTextEdits(
		"alpha beta gamma",
		[
			{ oldText: "alpha", newText: "A" },
			{ oldText: "gamma", newText: "G" },
		],
		"a.txt",
	);
	assert.equal(result, "A beta G");
});

test("applyTextEdits rejects overlapping edits", () => {
	assert.throws(
		() =>
			applyTextEdits(
				"abcdef",
				[
					{ oldText: "abc", newText: "A" },
					{ oldText: "bcd", newText: "B" },
				],
				"a.txt",
			),
		/overlap/,
	);
});

test("applyTextEdits handles one edit without changing semantics", () => {
	const result = applyTextEdits("prefix target suffix", [{ oldText: "target", newText: "done" }], "a.txt");
	assert.equal(result, "prefix done suffix");
});

test("applyTextEdits matches LF oldText against CRLF content", () => {
	const result = applyTextEdits("alpha\r\nbeta\r\n", [{ oldText: "alpha\nbeta\n", newText: "done\n" }], "a.txt");
	assert.equal(result, "done\n");
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
		assert.equal(extractText(second).trim(), dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeBashNative resets shell session on demand", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-bash-reset-"));
	try {
		await executeBashNative("cd ..", dir, undefined, undefined);
		const reset = await executeBashNative("pwd", dir, undefined, undefined, undefined, { resetSession: true });
		assert.equal(extractText(reset).trim(), dir);
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
