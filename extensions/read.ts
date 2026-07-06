import type { ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "./shared.ts";
import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	STREAMING_THRESHOLD,
	STREAM_READ_CHUNK_SIZE,
	createReadStream,
	createStatRevisionId,
	formatSize,
	normalizePath,
	readFile,
	rememberDocumentSnapshot,
	splitContentLines,
	stat,
	throwIfAborted,
	truncateHead,
	toolError,
} from "./shared.ts";

type ReadRangeRequest = {
	start: number;
	end?: number;
	before?: number;
	after?: number;
};

type NormalizedReadRange = {
	start: number;
	end: number;
	before: number;
	after: number;
	displayStart: number;
	displayEnd: number;
};

type MergedReadRangeBlock = {
	requests: NormalizedReadRange[];
	displayStart: number;
	displayEnd: number;
};

type CollectedRangeLine = {
	lineNumber: number;
	line: string;
};

type CollectedReadRangeBlock = {
	requests: NormalizedReadRange[];
	requestedDisplayStart: number;
	requestedDisplayEnd: number;
	lines: CollectedRangeLine[];
};

type ReadDetails = ReadToolDetails & { snapshotId?: string };

const readRangeSchema = Type.Object({
	start: Type.Integer({ minimum: 1, description: "First line in the requested range (1-indexed)." }),
	end: Type.Optional(Type.Integer({ minimum: 1, description: "Last line in the requested range (inclusive). Defaults to start." })),
	before: Type.Optional(Type.Integer({ minimum: 0, description: "Extra context lines to include before the requested range." })),
	after: Type.Optional(Type.Integer({ minimum: 0, description: "Extra context lines to include after the requested range." })),
});

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed). Must be >= 1." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read. Must be >= 1." })),
	ranges: Type.Optional(
		Type.Array(readRangeSchema, {
			minItems: 1,
			description:
				"Explicit line ranges to read. Each range can include before/after context, e.g. { start: 20, end: 40, before: 2, after: 2 }. Mutually exclusive with offset/limit.",
		}),
	),
});

function readError(code: string, message: string, hint?: string, details?: Record<string, unknown>): Error {
	return toolError({ tool: "read", code, message, hint, details, retryable: code !== "offset_out_of_range" });
}

function formatOffsetOutOfRangeMessage(offset: number, totalLines: number): string {
	if (totalLines === 0) return `Line ${offset} is beyond end of file (0 lines total). The file is empty.`;
	return `Line ${offset} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`;
}

function detectBinaryContent(buffer: Buffer, path: string): void {
	if (!buffer.includes(0)) return;
	throw readError(
		"binary_file",
		`File appears to be binary and cannot be read as text: ${path}`,
		"Use a different tool or inspect the file outside this text read path.",
		{ path },
	);
}

function formatReadLine(line: string, lineNumber: number, forceLineNumbers = false): string {
	if (forceLineNumbers) return `${lineNumber}|${line}`;
	return line;
}

function buildReadResponseText(text: string, snapshotId: string): string {
	return text.length > 0 ? `${text}\nsnapshotId: ${snapshotId}` : `snapshotId: ${snapshotId}`;
}

function buildOffsetOutOfRangeResult(offset: number, totalLines: number, snapshotId: string): { content: TextContent[]; details: ReadDetails } {
	return {
		content: [{ type: "text", text: `${formatOffsetOutOfRangeMessage(offset, totalLines)}\nsnapshotId: ${snapshotId}` }],
		details: { snapshotId },
	};
}

function finalizeContiguousReadResult(
	outputText: string,
	snapshotId: string,
	startLine: number,
	totalLines: number,
	limit: number | undefined,
): { content: TextContent[]; details: ReadDetails } {
	const truncation = truncateHead(outputText);
	let finalText = buildReadResponseText(truncation.content, snapshotId);
	const details: ReadDetails = { snapshotId };

	if (truncation.truncated) {
		const nextOffset = startLine + truncation.outputLines + 1;
		const truncatedBy = truncation.truncatedBy === "lines" ? `${truncation.outputLines} lines` : formatSize(truncation.outputBytes);
		finalText += `\n\n[Showing lines ${startLine + 1}-${startLine + truncation.outputLines} of ${totalLines} (truncated at ${truncatedBy}). Use offset=${nextOffset} to continue.]`;
		details.truncation = truncation;
	} else if (limit !== undefined && startLine + limit < totalLines) {
		const remaining = totalLines - (startLine + limit);
		const nextOffset = startLine + limit + 1;
		finalText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
	}

	return { content: [{ type: "text", text: finalText }], details };
}

function validateReadArguments(
	offset: number | undefined,
	limit: number | undefined,
	ranges: ReadRangeRequest[] | undefined,
): void {
	if (!ranges || ranges.length === 0) return;
	if (offset !== undefined || limit !== undefined) {
		throw readError(
			"invalid_input",
			"Read failed: ranges cannot be combined with offset or limit.",
			"Use either offset/limit for one contiguous slice, or ranges for explicit line windows.",
		);
	}
}

function normalizeReadRanges(ranges: ReadRangeRequest[]): NormalizedReadRange[] {
	return ranges
		.map((range, index) => {
			const end = range.end ?? range.start;
			if (end < range.start) {
				throw readError(
					"invalid_range",
					`Read failed: range ${index + 1} has end ${end} before start ${range.start}.`,
					"Use start <= end for each range.",
					{ range },
				);
			}
			const before = range.before ?? 0;
			const after = range.after ?? 0;
			return {
				start: range.start,
				end,
				before,
				after,
				displayStart: Math.max(1, range.start - before),
				displayEnd: end + after,
			};
		})
		.sort((a, b) => a.displayStart - b.displayStart || a.displayEnd - b.displayEnd);
}

function mergeReadRangeBlocks(ranges: NormalizedReadRange[], totalLines?: number): MergedReadRangeBlock[] {
	const merged: MergedReadRangeBlock[] = [];
	for (const range of ranges) {
		const displayEnd = totalLines === undefined ? range.displayEnd : Math.min(range.displayEnd, totalLines);
		const current: MergedReadRangeBlock = {
			requests: [range],
			displayStart: range.displayStart,
			displayEnd: displayEnd,
		};
		const previous = merged[merged.length - 1];
		if (!previous || current.displayStart > previous.displayEnd + 1) {
			merged.push(current);
			continue;
		}
		previous.requests.push(range);
		previous.displayEnd = Math.max(previous.displayEnd, current.displayEnd);
	}
	return merged;
}

function formatRequestedRangeLabel(range: NormalizedReadRange): string {
	return range.start === range.end ? `line ${range.start}` : `lines ${range.start}-${range.end}`;
}

function formatRangeBlockHeader(requests: NormalizedReadRange[], actualStart: number, actualEnd: number): string {
	const actualLabel = actualStart === actualEnd ? `line ${actualStart}` : `lines ${actualStart}-${actualEnd}`;
	if (requests.length === 1) {
		const request = requests[0]!;
		const requestedLabel = formatRequestedRangeLabel(request);
		const hasContext = request.before > 0 || request.after > 0;
		if (!hasContext && actualStart === request.start && actualEnd === request.end) return `[${requestedLabel}]`;
		const contextLabel = hasContext ? ` | context -${request.before}/+${request.after}` : "";
		return `[${actualLabel} | requested ${requestedLabel}${contextLabel}]`;
	}
	return `[${actualLabel} | merged requests: ${requests.map(formatRequestedRangeLabel).join(", ")}]`;
}

function formatCollectedRangeBlocks(blocks: CollectedReadRangeBlock[]): string {
	return blocks
		.filter((block) => block.lines.length > 0)
		.map((block) => {
			const actualStart = block.lines[0]!.lineNumber;
			const actualEnd = block.lines[block.lines.length - 1]!.lineNumber;
			const header = formatRangeBlockHeader(block.requests, actualStart, actualEnd);
			const body = block.lines.map((line) => formatReadLine(line.line, line.lineNumber, true)).join("\n");
			return `${header}\n${body}`;
		})
		.join("\n\n");
}

function buildRangeNotices(ranges: NormalizedReadRange[], totalLines: number): string[] {
	const notices: string[] = [];
	const outOfRangeCount = ranges.filter((range) => range.start > totalLines).length;
	const clippedCount = ranges.filter((range) => range.start <= totalLines && range.displayEnd > totalLines).length;
	if (outOfRangeCount > 0) notices.push(`${outOfRangeCount} requested range(s) started beyond EOF (${totalLines} lines total)`);
	if (clippedCount > 0) notices.push(`${clippedCount} range(s) clipped at EOF`);
	return notices;
}

function appendRangeFooter(text: string, notices: string[], details: ReadDetails): { text: string; details: ReadDetails | undefined } {
	const truncation = truncateHead(text);
	let finalText = truncation.content;
	if (truncation.truncated) {
		const truncatedBy = truncation.truncatedBy === "lines" ? `${truncation.outputLines} lines` : formatSize(truncation.outputBytes);
		notices.unshift(`Range read truncated at ${truncatedBy}. Reduce ranges or split the request`);
		details.truncation = truncation;
	}
	if (notices.length > 0) finalText += `\n\n[${notices.join(". ")}.]`;
	return { text: finalText, details: Object.keys(details).length > 0 ? details : undefined };
}

function createCollectedRangeBlocks(mergedBlocks: MergedReadRangeBlock[]): CollectedReadRangeBlock[] {
	return mergedBlocks.map((block) => ({
		requests: block.requests,
		requestedDisplayStart: block.displayStart,
		requestedDisplayEnd: block.displayEnd,
		lines: [],
	}));
}

function finalizeRangeReadResult(
	blocks: CollectedReadRangeBlock[],
	ranges: NormalizedReadRange[],
	totalLines: number,
	snapshotId: string,
): { content: TextContent[]; details: ReadDetails | undefined } {
	if (ranges.every((range) => range.start > totalLines)) return buildOffsetOutOfRangeResult(ranges[0]!.start, totalLines, snapshotId);
	const details: ReadDetails = { snapshotId };
	const response = appendRangeFooter(formatCollectedRangeBlocks(blocks), buildRangeNotices(ranges, totalLines), details);
	return { content: [{ type: "text", text: buildReadResponseText(response.text, snapshotId) }], details: response.details };
}

function buildRangeBlocksFromLines(allLines: string[], ranges: NormalizedReadRange[], totalLines: number): CollectedReadRangeBlock[] {
	const mergedBlocks = mergeReadRangeBlocks(ranges, totalLines);
	const blocks = createCollectedRangeBlocks(mergedBlocks);
	for (const block of blocks) {
		block.lines = allLines.slice(block.requestedDisplayStart - 1, block.requestedDisplayEnd).map((line, index) => ({
			lineNumber: block.requestedDisplayStart + index,
			line,
		}));
	}
	return blocks;
}

export async function executeReadStreaming(
	absolutePath: string,
	originalPath: string,
	offset: number | undefined,
	limit: number | undefined,
	signal: AbortSignal | undefined,
	snapshotId: string,
): Promise<{ content: TextContent[]; details: ReadDetails | undefined }> {
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const endLineExclusive = limit !== undefined ? startLine + limit : Number.POSITIVE_INFINITY;

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(readError("aborted", "Operation aborted", "Retry the read if cancellation was unintended.", { path: originalPath }));
			return;
		}

		const readStream = createReadStream(absolutePath, { highWaterMark: STREAM_READ_CHUNK_SIZE });
		const decoder = new StringDecoder("utf8");
		const selectedLines: string[] = [];
		let sawAnyBytes = false;
		let nextLineNumber = 1;
		let buffer = "";
		let resolved = false;

		function finish() {
			if (resolved) return;
			resolved = true;
			signal?.removeEventListener("abort", onAbort);
			buffer += decoder.end();
			if (buffer.length > 0) {
				handleLine(buffer, nextLineNumber);
				nextLineNumber++;
			} else if (sawAnyBytes) {
				handleLine("", nextLineNumber);
				nextLineNumber++;
			}

			const totalLines = nextLineNumber - 1;
			if (offset !== undefined && startLine >= totalLines) {
				resolve(buildOffsetOutOfRangeResult(offset, totalLines, snapshotId));
				return;
			}

			resolve(finalizeContiguousReadResult(selectedLines.join("\n"), snapshotId, startLine, totalLines, limit));
		}

		const onAbort = () => {
			readStream.destroy();
			reject(readError("aborted", "Operation aborted", "Retry the read if cancellation was unintended.", { path: originalPath }));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const handleLine = (line: string, lineNumber: number) => {
			if (lineNumber > startLine && lineNumber <= endLineExclusive) selectedLines.push(line);
		};

		readStream.on("data", (chunk: Buffer) => {
			try {
				detectBinaryContent(chunk, originalPath);
				sawAnyBytes = true;
				buffer += decoder.write(chunk);
				let newlineIdx: number;
				while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, newlineIdx);
					buffer = buffer.slice(newlineIdx + 1);
					handleLine(line, nextLineNumber);
					nextLineNumber++;
				}
				// ponytail: early-stop when we've passed requested window with a bounded limit
				if (limit !== undefined && nextLineNumber > endLineExclusive) {
					readStream.destroy();
					finish();
				}
			} catch (err) {
				readStream.destroy();
				reject(err as Error);
			}
		});

		readStream.on("end", () => {
			finish();
		});

		readStream.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			reject(readError("stream_read_failed", `Stream error reading ${originalPath}: ${err.message}`, undefined, { path: originalPath }));
		});
	});
}

async function executeReadRangesStreaming(
	absolutePath: string,
	originalPath: string,
	ranges: NormalizedReadRange[],
	signal: AbortSignal | undefined,
	snapshotId: string,
): Promise<{ content: TextContent[]; details: ReadDetails | undefined }> {
	const mergedBlocks = mergeReadRangeBlocks(ranges);
	const collectedBlocks = createCollectedRangeBlocks(mergedBlocks);
	const lastRequestedEnd = mergedBlocks.length > 0 ? mergedBlocks[mergedBlocks.length - 1]!.displayEnd : 0;

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(readError("aborted", "Operation aborted", "Retry the read if cancellation was unintended.", { path: originalPath }));
			return;
		}

		const readStream = createReadStream(absolutePath, { highWaterMark: STREAM_READ_CHUNK_SIZE });
		const decoder = new StringDecoder("utf8");
		let sawAnyBytes = false;
		let nextLineNumber = 1;
		let buffer = "";
		let currentBlockIndex = 0;
		let resolved = false;

		function finish() {
			if (resolved) return;
			resolved = true;
			signal?.removeEventListener("abort", onAbort);
			buffer += decoder.end();
			if (buffer.length > 0) {
				handleLine(buffer, nextLineNumber);
				nextLineNumber++;
			} else if (sawAnyBytes) {
				handleLine("", nextLineNumber);
				nextLineNumber++;
			}

			const totalLines = nextLineNumber - 1;
			resolve(finalizeRangeReadResult(collectedBlocks, ranges, totalLines, snapshotId));
		}

		const onAbort = () => {
			readStream.destroy();
			reject(readError("aborted", "Operation aborted", "Retry the read if cancellation was unintended.", { path: originalPath }));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const handleLine = (line: string, lineNumber: number) => {
			while (currentBlockIndex < collectedBlocks.length && lineNumber > collectedBlocks[currentBlockIndex]!.requestedDisplayEnd) currentBlockIndex++;
			if (currentBlockIndex >= collectedBlocks.length) return;
			const block = collectedBlocks[currentBlockIndex]!;
			if (lineNumber >= block.requestedDisplayStart && lineNumber <= block.requestedDisplayEnd) block.lines.push({ lineNumber, line });
		};

		readStream.on("data", (chunk: Buffer) => {
			try {
				detectBinaryContent(chunk, originalPath);
				sawAnyBytes = true;
				buffer += decoder.write(chunk);
				let newlineIdx: number;
				while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
					const line = buffer.slice(0, newlineIdx);
					buffer = buffer.slice(newlineIdx + 1);
					handleLine(line, nextLineNumber);
					nextLineNumber++;
				}
				// ponytail: early-stop when collected all requested ranges
				if (currentBlockIndex >= collectedBlocks.length && nextLineNumber > lastRequestedEnd) {
					readStream.destroy();
					finish();
				}
			} catch (err) {
				readStream.destroy();
				reject(err as Error);
			}
		});

		readStream.on("end", () => {
			finish();
		});

		readStream.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			reject(readError("stream_read_failed", `Stream error reading ${originalPath}: ${err.message}`, undefined, { path: originalPath }));
		});
	});
}

export async function executeRead(
	path: string,
	offset: number | undefined,
	limit: number | undefined,
	signal: AbortSignal | undefined,
	cwd: string,
	ranges?: ReadRangeRequest[],
): Promise<{ content: TextContent[]; details: ReadDetails | undefined }> {
	validateReadArguments(offset, limit, ranges);
	const normalizedRanges = ranges && ranges.length > 0 ? normalizeReadRanges(ranges) : undefined;
	const absolutePath = normalizePath(path, cwd);
	throwIfAborted(signal);

	let fileStat;
	try {
		fileStat = await stat(absolutePath);
	} catch (err: any) {
		throw readError(
			err.code === "ENOENT" ? "file_not_found" : err.code === "EACCES" ? "permission_denied" : "read_failed",
			err.code === "ENOENT" ? `File not found: ${path}` : err.code === "EACCES" ? `Permission denied: ${path}` : `Cannot access file: ${path}. ${err.message}`,
			err.code === "ENOENT" ? "Check the path and retry." : err.code === "EACCES" ? "Choose a readable path or adjust permissions." : undefined,
			{ path },
		);
	}
	throwIfAborted(signal);

	if (fileStat.size > STREAMING_THRESHOLD) {
		const snapshotId = createStatRevisionId(fileStat);
		if (normalizedRanges) return executeReadRangesStreaming(absolutePath, path, normalizedRanges, signal, snapshotId);
		return executeReadStreaming(absolutePath, path, offset, limit, signal, snapshotId);
	}

	const buffer = await readFile(absolutePath);
	throwIfAborted(signal);
	detectBinaryContent(buffer, path);
	const rawContent = buffer.toString("utf-8");
	const snapshotId = rememberDocumentSnapshot(absolutePath, rawContent);

	const { lines: fileLines, endsWithNewline } = splitContentLines(rawContent);
	const allLines = endsWithNewline ? fileLines.concat("") : fileLines;
	const totalFileLines = allLines.length;

	if (normalizedRanges) return finalizeRangeReadResult(buildRangeBlocksFromLines(allLines, normalizedRanges, totalFileLines), normalizedRanges, totalFileLines, snapshotId);

	const startLine = offset ? Math.max(0, offset - 1) : 0;
	if (offset !== undefined && startLine >= allLines.length) return buildOffsetOutOfRangeResult(offset, allLines.length, snapshotId);

	const selectedLines = limit !== undefined ? allLines.slice(startLine, startLine + limit) : allLines.slice(startLine);
	return finalizeContiguousReadResult(selectedLines.join("\n"), snapshotId, startLine, totalFileLines, limit);
}

export function registerReadTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read",
		label: "read",
		description: `Read the contents of a file. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Use offset/limit for large files, or ranges for explicit line windows with optional context. Large files (>5MB) are streamed to avoid OOM.`,
		promptSnippet: "Read file contents",
		promptGuidelines: [
			"Read is the primary way to inspect file contents. When the user names a file or you need its text, read it directly — don't grep or find first.",
			"Every read returns a snapshotId at the end of its output. Always copy this snapshotId to your next edit on the same file.",
			"After editing a file, the edit result includes a new snapshotId — use it directly for follow-up edits. No need to re-read the file.",
			"Don't read the same file twice in one tool call batch. One read per file, then edit with the snapshotId from that read.",
			"Only re-read a file when edit returns stale_snapshot or ambiguous. Never re-read just to confirm the edit result is correct.",
			"Use ranges for disjoint line windows or when you need before/after context around specific lines.",
		],
		parameters: readSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { path, offset, limit, ranges } = params as {
				path: string;
				offset?: number;
				limit?: number;
				ranges?: ReadRangeRequest[];
			};
			return executeRead(path, offset, limit, signal, ctx?.cwd ?? process.cwd(), ranges);
		},
	});
}
