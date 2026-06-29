import type { ExtensionAPI, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "./shared.ts";
import { Type } from "typebox";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	STREAMING_THRESHOLD,
	STREAM_READ_CHUNK_SIZE,
	createReadStream,
	ensureReadable,
	formatSize,
	joinContentLines,
	normalizePath,
	readFile,
	shortHash,
	splitContentLines,
	stat,
	throwIfAborted,
	truncateHead,
	toolError,
} from "./shared.ts";

function readError(code: string, message: string, hint?: string, details?: Record<string, unknown>): Error {
	return toolError({ tool: "read", code, message, hint, details, retryable: code !== "offset_out_of_range" });
}

function formatOffsetOutOfRangeMessage(offset: number, totalLines: number): string {
	if (totalLines === 0) return `Line ${offset} is beyond end of file (0 lines total). The file is empty.`;
	return `Line ${offset} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`;
}

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
	withHashlines: Type.Optional(
		Type.Boolean({
			description:
				"If true, each line is prefixed with LINE:SHORT_HASH| for hashline anchoring in subsequent edits. Default: false.",
		}),
	),
});

function detectBinaryContent(buffer: Buffer, path: string): void {
	if (!buffer.includes(0)) return;
	throw readError(
		"binary_file",
		`File appears to be binary and cannot be read as text: ${path}`,
		"Use a different tool or inspect the file outside this text read path.",
		{ path },
	);
}

function formatReadLine(line: string, lineNumber: number, withHashlines: boolean | undefined, forceLineNumbers = false): string {
	if (withHashlines) return `${lineNumber}:${shortHash(line)}|${line}`;
	if (forceLineNumbers) return `${lineNumber}|${line}`;
	return line;
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

function formatCollectedRangeBlocks(blocks: CollectedReadRangeBlock[], withHashlines: boolean | undefined): string {
	return blocks
		.filter((block) => block.lines.length > 0)
		.map((block) => {
			const actualStart = block.lines[0]!.lineNumber;
			const actualEnd = block.lines[block.lines.length - 1]!.lineNumber;
			const header = formatRangeBlockHeader(block.requests, actualStart, actualEnd);
			const body = block.lines
				.map((line) => formatReadLine(line.line, line.lineNumber, withHashlines, true))
				.join("\n");
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

function appendRangeFooter(text: string, notices: string[], details: ReadToolDetails): { text: string; details: ReadToolDetails | undefined } {
	const truncation = truncateHead(text);
	let finalText = truncation.content;
	if (truncation.truncated) {
		const truncatedBy =
			truncation.truncatedBy === "lines" ? `${truncation.outputLines} lines` : formatSize(truncation.outputBytes);
		notices.unshift(`Range read truncated at ${truncatedBy}. Reduce ranges or split the request`);
		details.truncation = truncation;
	}
	if (notices.length > 0) finalText += `\n\n[${notices.join(". ")}.]`;
	return { text: finalText, details: Object.keys(details).length > 0 ? details : undefined };
}

function buildRangeBlocksFromLines(
	allLines: string[],
	ranges: NormalizedReadRange[],
	totalLines: number,
): CollectedReadRangeBlock[] {
	return mergeReadRangeBlocks(ranges, totalLines).map((block) => ({
		requests: block.requests,
		requestedDisplayStart: block.displayStart,
		requestedDisplayEnd: block.displayEnd,
		lines: allLines.slice(block.displayStart - 1, block.displayEnd).map((line, index) => ({
			lineNumber: block.displayStart + index,
			line,
		})),
	}));
}

export async function executeReadStreaming(
	absolutePath: string,
	originalPath: string,
	offset: number | undefined,
	limit: number | undefined,
	withHashlines: boolean | undefined,
	fileStat: { size: number },
	signal: AbortSignal | undefined,
): Promise<{ content: TextContent[]; details: ReadToolDetails | undefined }> {
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	const maxTargetLines = limit ?? DEFAULT_MAX_LINES;

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(readError("aborted", "Operation aborted", "Retry the read if cancellation was unintended.", { path: originalPath }));
			return;
		}

		let readStream = createReadStream(absolutePath, {
			highWaterMark: STREAM_READ_CHUNK_SIZE,
		});

		const onAbort = () => {
			readStream.destroy();
			reject(readError("aborted", "Operation aborted", "Retry the read if cancellation was unintended.", { path: originalPath }));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const lines: string[] = [];
		let lineIndex = 0;
		let buf = "";
		let done = false;
		let finalizeOnClose = false;
		let endsWithNewline = false;
		let hitTargetLines = false;

		readStream.on("data", (chunk: Buffer) => {
			if (done) return;
			try {
				detectBinaryContent(chunk, originalPath);
			} catch (err) {
				done = true;
				readStream.destroy();
				reject(err as Error);
				return;
			}
			buf += chunk.toString("utf-8");

			let newlineIdx: number;
			while ((newlineIdx = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, newlineIdx);
				buf = buf.slice(newlineIdx + 1);

				if (lineIndex >= startLine && lines.length < maxTargetLines) {
					lines.push(line);
				}
				lineIndex++;

				if (lines.length >= maxTargetLines) {
					hitTargetLines = true;
					finalizeOnClose = true;
					readStream.destroy();
					break;
				}
			}
		});

		readStream.on("end", () => {
			if (done) return;
			endsWithNewline = buf.length === 0;
			if (buf.length > 0 && lineIndex >= startLine && lines.length < maxTargetLines) {
				lines.push(buf);
			}
			done = true;
			finalize();
		});

		readStream.on("close", () => {
			if (!done && finalizeOnClose) {
				done = true;
				finalize();
			}
		});

		readStream.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			reject(readError("stream_read_failed", `Stream error reading ${originalPath}: ${err.message}`, undefined, { path: originalPath }));
		});

		function finalize() {
			signal?.removeEventListener("abort", onAbort);
			try {
				const outputLines = endsWithNewline && lineIndex >= startLine && lines.length < maxTargetLines ? lines.concat("") : lines;
				const outputText = outputLines.map((line, i) => formatReadLine(line, startLine + i + 1, withHashlines)).join("\n");
				const truncation = truncateHead(outputText);
				let finalText = truncation.content;
				const details: ReadToolDetails = {};

				if (truncation.truncated || hitTargetLines) {
					const shownLines = truncation.truncated ? truncation.outputLines : outputLines.length;
					const nextOffset = startLine + shownLines + 1;
					const truncatedSuffix = truncation.truncated
						? ` (truncated at ${truncation.truncatedBy === "lines" ? `${truncation.outputLines} lines` : formatSize(truncation.outputBytes)})`
						: "";
					finalText += `\n\n[Streaming read: showing lines ${startLine + 1}-${startLine + shownLines} of approx ${Math.ceil(fileStat.size / 80)}${truncatedSuffix}. Use offset=${nextOffset} to continue.]`;
					if (truncation.truncated) details.truncation = truncation;
				} else {
					finalText += `\n\n[Streaming read complete: ${lines.length} lines]`;
				}

				resolve({ content: [{ type: "text", text: finalText }], details: Object.keys(details).length > 0 ? details : undefined });
			} catch (err: any) {
				reject(err);
			}
		}
	});
}

async function executeReadRangesStreaming(
	absolutePath: string,
	originalPath: string,
	ranges: NormalizedReadRange[],
	withHashlines: boolean | undefined,
	signal: AbortSignal | undefined,
): Promise<{ content: TextContent[]; details: ReadToolDetails | undefined }> {
	const mergedBlocks = mergeReadRangeBlocks(ranges);
	const collectedBlocks: CollectedReadRangeBlock[] = mergedBlocks.map((block) => ({
		requests: block.requests,
		requestedDisplayStart: block.displayStart,
		requestedDisplayEnd: block.displayEnd,
		lines: [],
	}));
	const maxDisplayEnd = Math.max(...mergedBlocks.map((block) => block.displayEnd));

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(readError("aborted", "Operation aborted", "Retry the read if cancellation was unintended.", { path: originalPath }));
			return;
		}

		let readStream = createReadStream(absolutePath, { highWaterMark: STREAM_READ_CHUNK_SIZE });
		const onAbort = () => {
			readStream.destroy();
			reject(readError("aborted", "Operation aborted", "Retry the read if cancellation was unintended.", { path: originalPath }));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		let buf = "";
		let done = false;
		let finalizeOnClose = false;
		let nextLineNumber = 1;
		let reachedEof = false;
		let currentBlockIndex = 0;

		const handleLine = (line: string, lineNumber: number) => {
			while (currentBlockIndex < collectedBlocks.length && lineNumber > collectedBlocks[currentBlockIndex]!.requestedDisplayEnd) {
				currentBlockIndex++;
			}
			if (currentBlockIndex >= collectedBlocks.length) {
				finalizeOnClose = true;
				readStream.destroy();
				return;
			}
			const block = collectedBlocks[currentBlockIndex]!;
			if (lineNumber >= block.requestedDisplayStart && lineNumber <= block.requestedDisplayEnd) {
				block.lines.push({ lineNumber, line });
			}
			if (lineNumber >= maxDisplayEnd) {
				finalizeOnClose = true;
				readStream.destroy();
			}
		};

		readStream.on("data", (chunk: Buffer) => {
			if (done) return;
			try {
				detectBinaryContent(chunk, originalPath);
			} catch (err) {
				done = true;
				readStream.destroy();
				reject(err as Error);
				return;
			}
			buf += chunk.toString("utf-8");
			let newlineIdx: number;
			while ((newlineIdx = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, newlineIdx);
				buf = buf.slice(newlineIdx + 1);
				handleLine(line, nextLineNumber);
				nextLineNumber++;
				if (finalizeOnClose) break;
			}
		});

		readStream.on("end", () => {
			if (done) return;
			reachedEof = true;
			if (buf.length > 0) {
				handleLine(buf, nextLineNumber);
				nextLineNumber++;
			} else {
				handleLine("", nextLineNumber);
				nextLineNumber++;
			}
			done = true;
			finalize();
		});

		readStream.on("close", () => {
			if (!done && finalizeOnClose) {
				done = true;
				finalize();
			}
		});

		readStream.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			reject(readError("stream_read_failed", `Stream error reading ${originalPath}: ${err.message}`, undefined, { path: originalPath }));
		});

		function finalize() {
			signal?.removeEventListener("abort", onAbort);
			try {
				const totalLines = reachedEof ? nextLineNumber - 1 : undefined;
				if (totalLines !== undefined && ranges.every((range) => range.start > totalLines)) {
					resolve({
						content: [{ type: "text", text: formatOffsetOutOfRangeMessage(ranges[0]!.start, totalLines) }],
						details: undefined,
					});
					return;
				}

				const body = formatCollectedRangeBlocks(collectedBlocks, withHashlines);
				const notices = totalLines !== undefined ? buildRangeNotices(ranges, totalLines) : [];
				const details: ReadToolDetails = {};
				const response = appendRangeFooter(body, notices, details);
				resolve({ content: [{ type: "text", text: response.text }], details: response.details });
			} catch (err: any) {
				reject(err);
			}
		}
	});
}

export async function executeRead(
	path: string,
	offset: number | undefined,
	limit: number | undefined,
	withHashlines: boolean | undefined,
	signal: AbortSignal | undefined,
	cwd: string,
	ranges?: ReadRangeRequest[],
): Promise<{ content: TextContent[]; details: ReadToolDetails | undefined }> {
	validateReadArguments(offset, limit, ranges);
	const normalizedRanges = ranges && ranges.length > 0 ? normalizeReadRanges(ranges) : undefined;
	const absolutePath = normalizePath(path, cwd);
	await ensureReadable(path, absolutePath);
	throwIfAborted(signal);

	const fileStat = await stat(absolutePath);
	if (fileStat.size > STREAMING_THRESHOLD) {
		if (normalizedRanges) return executeReadRangesStreaming(absolutePath, path, normalizedRanges, withHashlines, signal);
		return executeReadStreaming(absolutePath, path, offset, limit, withHashlines, fileStat, signal);
	}

	const buffer = await readFile(absolutePath);
	throwIfAborted(signal);
	detectBinaryContent(buffer, path);

	const { lines: fileLines, endsWithNewline } = splitContentLines(buffer.toString("utf-8"));
	const allLines = endsWithNewline ? fileLines.concat("") : fileLines;
	const totalFileLines = allLines.length;

	if (normalizedRanges) {
		if (normalizedRanges.every((range) => range.start > totalFileLines)) {
			return {
				content: [{ type: "text", text: formatOffsetOutOfRangeMessage(normalizedRanges[0]!.start, totalFileLines) }],
				details: undefined,
			};
		}
		const blocks = buildRangeBlocksFromLines(allLines, normalizedRanges, totalFileLines);
		const body = formatCollectedRangeBlocks(blocks, withHashlines);
		const details: ReadToolDetails = {};
		const response = appendRangeFooter(body, buildRangeNotices(normalizedRanges, totalFileLines), details);
		return { content: [{ type: "text", text: response.text }], details: response.details };
	}

	const startLine = offset ? Math.max(0, offset - 1) : 0;
	if (offset !== undefined && startLine >= allLines.length) {
		return {
			content: [{ type: "text", text: formatOffsetOutOfRangeMessage(offset, allLines.length) }],
			details: undefined,
		};
	}

	const selectedLines = limit !== undefined ? allLines.slice(startLine, startLine + limit) : allLines.slice(startLine);
	const outputText = selectedLines.map((line, i) => formatReadLine(line, startLine + i + 1, withHashlines)).join("\n");
	const truncation = truncateHead(outputText);
	let finalText = truncation.content;
	const details: ReadToolDetails = {};

	if (truncation.truncated) {
		const nextOffset = startLine + truncation.outputLines + 1;
		const truncatedBy =
			truncation.truncatedBy === "lines" ? `${truncation.outputLines} lines` : formatSize(truncation.outputBytes);
		finalText += `\n\n[Showing lines ${startLine + 1}-${startLine + truncation.outputLines} of ${totalFileLines} (truncated at ${truncatedBy}). Use offset=${nextOffset} to continue.]`;
		details.truncation = truncation;
	} else if (limit !== undefined && startLine + limit < allLines.length) {
		const remaining = allLines.length - (startLine + limit);
		const nextOffset = startLine + limit + 1;
		finalText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
	}

	return { content: [{ type: "text", text: finalText }], details: Object.keys(details).length > 0 ? details : undefined };
}

export function registerReadTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read",
		label: "read (hashline-enhanced)",
		description: `Read the contents of a file with hashline support. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Use offset/limit for large files, or ranges for explicit line windows with optional context. Set withHashlines=true to get LINE:HASH|prefix for each line. Large files (>5MB) are streamed to avoid OOM.`,
		promptSnippet: "Read file contents with hashline support",
		promptGuidelines: [
			"Use read when the user wants file contents or you need the exact current text.",
			"If the user already named the file but wants search, counts, or a direct unique replacement, use grep or edit instead of reading first.",
			"Use withHashlines=true before hashline-anchored edits to capture fresh LINE:HASH prefixes.",
			"Use ranges for disjoint line windows or when you need before/after context around specific lines.",
		],
		parameters: readSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { path, offset, limit, ranges, withHashlines } = params as {
				path: string;
				offset?: number;
				limit?: number;
				ranges?: ReadRangeRequest[];
				withHashlines?: boolean;
			};
			return executeRead(path, offset, limit, withHashlines, signal, ctx?.cwd ?? process.cwd(), ranges);
		},
	});
}
