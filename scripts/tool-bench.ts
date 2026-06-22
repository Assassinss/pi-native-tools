import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { applyTextEdits } from "../extensions/edit.ts";
import { executeRead } from "../extensions/read.ts";
import { joinContentLines, STREAM_READ_CHUNK_SIZE, WRITE_CHUNK_SIZE } from "../extensions/shared.ts";
import { executeWrite } from "../extensions/write.ts";

function formatMs(value: number): string {
	return `${value.toFixed(1)} ms`;
}

function ratio(base: number, candidate: number): string {
	return `${(base / candidate).toFixed(2)}x`;
}

async function time<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
	const start = performance.now();
	const value = await fn();
	return { ms: performance.now() - start, value };
}

async function average<T>(runs: number, fn: () => Promise<T>): Promise<{ meanMs: number; lastValue: T }> {
	let total = 0;
	let lastValue!: T;
	for (let i = 0; i < runs; i++) {
		const timed = await time(fn);
		total += timed.ms;
		lastValue = timed.value;
	}
	return { meanMs: total / runs, lastValue };
}

async function legacyReadStreamingDefault(path: string): Promise<string> {
	const fileStat = await stat(path);
	const maxTargetLines = DEFAULT_MAX_LINES;

	return new Promise((resolve, reject) => {
		const readStream = createReadStream(path, { highWaterMark: STREAM_READ_CHUNK_SIZE });
		const lines: string[] = [];
		let lineIndex = 0;
		let buf = "";
		let endsWithNewline = false;

		readStream.on("data", (chunk: Buffer) => {
			buf += chunk.toString("utf-8");
			let newlineIdx: number;
			while ((newlineIdx = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, newlineIdx);
				buf = buf.slice(newlineIdx + 1);
				if (lines.length < maxTargetLines) lines.push(line);
				lineIndex++;
			}
		});

		readStream.on("end", () => {
			endsWithNewline = buf.length === 0;
			if (buf.length > 0 && lines.length < maxTargetLines) lines.push(buf);
			const outputLines = endsWithNewline && lines.length < maxTargetLines ? [...lines, ""] : lines;
			const outputText = joinContentLines(outputLines, false);
			const truncation = truncateHead(outputText);
			let finalText = truncation.content;
			if (truncation.truncated) {
				const nextOffset = truncation.outputLines + 1;
				finalText += `\n\n[Streaming read: showing lines 1-${truncation.outputLines} of approx ${Math.ceil(fileStat.size / 80)} (truncated at ${truncation.outputLines} lines). Use offset=${nextOffset} to continue.]`;
			} else {
				finalText += `\n\n[Streaming read complete: ${lines.length} lines]`;
			}
			resolve(finalText);
		});

		readStream.on("error", reject);
	});
}

function getSafeChunkEnd(content: string, start: number, maxCodeUnits: number): number {
	let end = Math.min(start + maxCodeUnits, content.length);
	if (end < content.length) {
		const prev = content.charCodeAt(end - 1);
		const next = content.charCodeAt(end);
		const prevIsHighSurrogate = prev >= 0xd800 && prev <= 0xdbff;
		const nextIsLowSurrogate = next >= 0xdc00 && next <= 0xdfff;
		if (prevIsHighSurrogate && nextIsLowSurrogate) end--;
	}
	return end;
}

async function legacyWriteStreaming(path: string, content: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const writeStream = createWriteStream(path, { highWaterMark: WRITE_CHUNK_SIZE });
		const buffer = Buffer.from(content, "utf-8");
		let offset = 0;
		let bytesWritten = 0;

		writeStream.on("error", reject);
		writeStream.on("finish", async () => {
			try {
				hash.digest("hex");
				const writtenStat = await stat(path);
				if (writtenStat.size !== bytesWritten) throw new Error("size mismatch");
				resolve(bytesWritten);
			} catch (error) {
				reject(error);
			}
		});

		const writeNextChunk = () => {
			if (offset >= buffer.length) {
				writeStream.end();
				return;
			}
			const end = Math.min(offset + WRITE_CHUNK_SIZE, buffer.length);
			const chunk = buffer.subarray(offset, end);
			hash.update(chunk);
			bytesWritten += chunk.length;
			offset = end;
			if (!writeStream.write(chunk)) writeStream.once("drain", writeNextChunk);
			else setImmediate(writeNextChunk);
		};

		writeNextChunk();
	});
}

async function currentWriteStreaming(path: string, content: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const writeStream = createWriteStream(path, { highWaterMark: WRITE_CHUNK_SIZE });
		let offset = 0;
		let bytesWritten = 0;

		writeStream.on("error", reject);
		writeStream.on("finish", async () => {
			try {
				hash.digest("hex");
				const writtenStat = await stat(path);
				if (writtenStat.size !== bytesWritten) throw new Error("size mismatch");
				resolve(bytesWritten);
			} catch (error) {
				reject(error);
			}
		});

		const writeNextChunk = () => {
			while (offset < content.length) {
				const end = getSafeChunkEnd(content, offset, WRITE_CHUNK_SIZE);
				const chunk = content.slice(offset, end);
				const chunkBuffer = Buffer.from(chunk, "utf-8");
				bytesWritten += chunkBuffer.length;
				hash.update(chunkBuffer);
				offset = end;
				if (!writeStream.write(chunkBuffer)) {
					writeStream.once("drain", writeNextChunk);
					return;
				}
			}
			writeStream.end();
		};

		writeNextChunk();
	});
}

function legacyApplyTextEdits(content: string, edits: Array<{ oldText: string; newText: string }>, filePath: string): string {
	let result = content;
	for (const edit of edits) {
		const idx = result.indexOf(edit.oldText);
		if (idx === -1) {
			const normalizedOld = edit.oldText.endsWith("\n") ? edit.oldText.slice(0, -1) : edit.oldText;
			const idx2 = result.indexOf(normalizedOld);
			if (idx2 === -1) {
				throw new Error(`Edit failed: oldText not found in ${filePath}.`);
			}
			result = result.slice(0, idx2) + edit.newText + result.slice(idx2 + normalizedOld.length);
		} else {
			const secondIdx = result.indexOf(edit.oldText, idx + 1);
			if (secondIdx !== -1) {
				throw new Error(`Edit failed: oldText appears multiple times in ${filePath}.`);
			}
			result = result.slice(0, idx) + edit.newText + result.slice(idx + edit.oldText.length);
		}
	}
	return result;
}

async function benchRead(root: string) {
	const file = join(root, "large-read.txt");
	const content = "line\n".repeat(1400000);
	await writeFile(file, content, "utf-8");

	const currentDefault = await average(3, () => executeRead(file, undefined, undefined, false, undefined, root));
	const legacyDefault = await average(3, () => legacyReadStreamingDefault(file));
	const currentLimited = await average(5, () => executeRead(file, 10, 3, false, undefined, root));
	return {
		bytes: Buffer.byteLength(content, "utf-8"),
		currentDefaultMs: currentDefault.meanMs,
		legacyDefaultMs: legacyDefault.meanMs,
		currentLimitedMs: currentLimited.meanMs,
	};
}

async function benchWrite(root: string) {
	const asciiPath = join(root, "large-write-ascii.txt");
	const asciiLegacyPath = join(root, "large-write-ascii-legacy.txt");
	const unicodePath = join(root, "large-write-unicode.txt");
	const unicodeLegacyPath = join(root, "large-write-unicode-legacy.txt");
	const ascii = "0123456789abcdef\n".repeat(400000);
	const unicode = "😀0123456789abcdef\n".repeat(350000);

	const toolAscii = await average(3, () => executeWrite(asciiPath, ascii, undefined, root));
	const legacyAscii = await average(3, () => legacyWriteStreaming(asciiLegacyPath, ascii));
	const currentAscii = await average(3, () => currentWriteStreaming(asciiPath, ascii));
	const toolUnicode = await average(3, () => executeWrite(unicodePath, unicode, undefined, root));
	const legacyUnicode = await average(3, () => legacyWriteStreaming(unicodeLegacyPath, unicode));
	const currentUnicode = await average(3, () => currentWriteStreaming(unicodePath, unicode));
	const unicodeRoundTrip = await readFile(unicodePath, "utf-8");
	return {
		asciiBytes: Buffer.byteLength(ascii, "utf-8"),
		toolAsciiMs: toolAscii.meanMs,
		legacyAsciiMs: legacyAscii.meanMs,
		currentAsciiMs: currentAscii.meanMs,
		unicodeBytes: Buffer.byteLength(unicode, "utf-8"),
		toolUnicodeMs: toolUnicode.meanMs,
		legacyUnicodeMs: legacyUnicode.meanMs,
		currentUnicodeMs: currentUnicode.meanMs,
		unicodeVerified: unicodeRoundTrip === unicode,
	};
}

async function benchEdit() {
	const base = Array.from({ length: 120000 }, (_, i) => `line-${i}: keep this text`).join("\n");
	const edits = [
		{ oldText: "line-1000: keep this text", newText: "line-1000: changed" },
		{ oldText: "line-60000: keep this text", newText: "line-60000: changed" },
		{ oldText: "line-110000: keep this text", newText: "line-110000: changed" },
	];
	const current = await average(20, async () => applyTextEdits(base, edits, "bench.txt"));
	const legacy = await average(20, async () => legacyApplyTextEdits(base, edits, "bench.txt"));
	return {
		chars: base.length,
		edits: edits.length,
		currentMs: current.meanMs,
		legacyMs: legacy.meanMs,
	};
}

async function main() {
	const root = await mkdtemp(join(tmpdir(), "pi-tools-bench-"));
	try {
		const [readBench, writeBench, editBench] = await Promise.all([benchRead(root), benchWrite(root), benchEdit()]);

		console.log(`read default ${formatSize(readBench.bytes)}: current=${formatMs(readBench.currentDefaultMs)} legacy-hotspot=${formatMs(readBench.legacyDefaultMs)} speedup=${ratio(readBench.legacyDefaultMs, readBench.currentDefaultMs)}`);
		console.log(`read offset/limit ${formatSize(readBench.bytes)}: current=${formatMs(readBench.currentLimitedMs)}`);
		console.log(`write ascii ${formatSize(writeBench.asciiBytes)}: tool=${formatMs(writeBench.toolAsciiMs)} current-hotspot=${formatMs(writeBench.currentAsciiMs)} legacy-hotspot=${formatMs(writeBench.legacyAsciiMs)} speedup=${ratio(writeBench.legacyAsciiMs, writeBench.currentAsciiMs)}`);
		console.log(`write unicode ${formatSize(writeBench.unicodeBytes)}: tool=${formatMs(writeBench.toolUnicodeMs)} current-hotspot=${formatMs(writeBench.currentUnicodeMs)} legacy-hotspot=${formatMs(writeBench.legacyUnicodeMs)} speedup=${ratio(writeBench.legacyUnicodeMs, writeBench.currentUnicodeMs)} verified=${writeBench.unicodeVerified}`);
		console.log(`edit ${editBench.edits} replacements over ${editBench.chars} chars: current=${formatMs(editBench.currentMs)} legacy=${formatMs(editBench.legacyMs)} speedup=${ratio(editBench.legacyMs, editBench.currentMs)}`);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

await main();
