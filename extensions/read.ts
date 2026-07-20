import { convertToPng, formatDimensionNote, resizeImage, type ExtensionAPI, type ReadToolDetails } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { TextContent } from "./shared.ts";
import { open } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Type } from "typebox";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	createRevisionId,
	createStatRevisionId,
	formatSize,
	getCurrentDocumentRevision,
	getCompleteDocumentReadKey,
	getDocumentFingerprint,
	normalizePath,
	readFile,
	rememberDocumentRevision,
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

type ReadLocation = {
	path: string;
	ranges: ReadRangeRequest[];
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

type ReadDetails = ReadToolDetails & { snapshotId?: string; snapshots?: Record<string, string> };

const MAX_TEXT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;

type OutlineEntry = { lineNumber: number; line: string };
type OutlineResult = { entries: OutlineEntry[]; totalEntries: number; truncated: boolean };
type CollectionBudget = { lines: number; characters: number; exhausted: boolean };

// ponytail: regex-based outline patterns, upgrade to tree-sitter if precision matters
const OUTLINE_PATTERNS: Record<string, RegExp[]> = {
	ts: [/^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s/, /^\s*import\s/],
	tsx: [/^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\s/, /^\s*import\s/],
	js: [/^\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s/, /^\s*import\s/],
	jsx: [/^\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s/, /^\s*import\s/],
	mjs: [/^\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s/, /^\s*import\s/],
	cjs: [/^\s*(?:export\s+)?(?:async\s+)?(?:function|class)\s/, /^\s*import\s/],
	py: [/^\s*(?:async\s+)?def\s/, /^\s*class\s/, /^\s*@\w/, /^\s*(?:from\s+\S+\s+)?import\s/],
	pyi: [/^\s*(?:async\s+)?def\s/, /^\s*class\s/, /^\s*@\w/, /^\s*(?:from\s+\S+\s+)?import\s/],
	pyx: [/^\s*(?:async\s+)?def\s/, /^\s*class\s/, /^\s*@\w/, /^\s*(?:from\s+\S+\s+)?import\s/],
	rs: [/^\s*(?:pub\s+)?(?:async\s+)?fn\s/, /^\s*(?:pub\s+)?struct\s/, /^\s*(?:pub\s+)?enum\s/, /^\s*(?:pub\s+)?trait\s/, /^\s*(?:pub\s+)?impl\b/, /^\s*(?:pub\s+)?mod\s/, /^\s*use\s/, /^\s*macro_rules!/],
	go: [/^\s*func\s/, /^\s*type\s/, /^\s*var\s/, /^\s*const\s/, /^\s*import\b/],
	java: [/^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:abstract\s+)?(?:class|interface|enum|@interface)\s/],
	c: [/^\s*#(?:include|define|ifdef|ifndef|pragma)/, /^\s*(?:struct|enum)\s/],
	cpp: [/^\s*#(?:include|define|ifdef|ifndef|pragma)/, /^\s*(?:struct|class|enum)\s/],
	h: [/^\s*#(?:include|define|ifdef|ifndef|pragma)/, /^\s*(?:struct|class|enum)\s/],
	hpp: [/^\s*#(?:include|define|ifdef|ifndef|pragma)/, /^\s*(?:struct|class|enum)\s/],
	cc: [/^\s*#(?:include|define|ifdef|ifndef|pragma)/, /^\s*(?:struct|class|enum)\s/],
	cxx: [/^\s*#(?:include|define|ifdef|ifndef|pragma)/, /^\s*(?:struct|class|enum)\s/],
	md: [/^#{1,6}\s/],
	json: [/^\S/],
	yaml: [/^\S/],
	yml: [/^\S/],
};

const GENERIC_OUTLINE_PATTERN = /^\S/;

function getOutlinePatterns(filePath: string): RegExp[] {
	const ext = extname(filePath).slice(1).toLowerCase();
	return OUTLINE_PATTERNS[ext] ?? [GENERIC_OUTLINE_PATTERN];
}

function forEachContentLine(content: string, visit: (line: string, lineNumber: number) => void): number {
	if (content.length === 0) return 0;
	let lineNumber = 1;
	let start = 0;
	while (true) {
		const newline = content.indexOf("\n", start);
		if (newline === -1) {
			visit(content.slice(start), lineNumber);
			return lineNumber;
		}
		visit(content.slice(start, newline), lineNumber++);
		start = newline + 1;
		if (start === content.length) {
			visit("", lineNumber);
			return lineNumber;
		}
	}
}

function createCollectionBudget(): CollectionBudget {
	return { lines: 0, characters: 0, exhausted: false };
}

function truncateTextSafely(text: string, maxCharacters: number): string {
	let end = Math.min(text.length, maxCharacters);
	if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
	return text.slice(0, end);
}

function collectBoundedLine<T>(items: T[], item: T, text: string, budget: CollectionBudget): void {
	if (budget.exhausted) return;
	const remainingCharacters = DEFAULT_MAX_BYTES + 1 - budget.characters;
	if (budget.lines >= DEFAULT_MAX_LINES + 1 || remainingCharacters <= 0) {
		budget.exhausted = true;
		return;
	}
	const boundedText = truncateTextSafely(text, remainingCharacters);
	items.push(typeof item === "string" ? boundedText as T : { ...(item as object), line: boundedText } as T);
	budget.lines++;
	budget.characters += boundedText.length + 1;
	if (boundedText.length < text.length) budget.exhausted = true;
}

function buildOutline(content: string, filePath: string): OutlineResult {
	const patterns = getOutlinePatterns(filePath);
	const entries: OutlineEntry[] = [];
	const budget = createCollectionBudget();
	let totalEntries = 0;
	forEachContentLine(content, (line, lineNumber) => {
		if (line.length === 0 || !patterns.some((pattern) => pattern.test(line))) return;
		totalEntries++;
		const trimmed = line.trim();
		collectBoundedLine(entries, { lineNumber, line: trimmed }, trimmed, budget);
	});
	return { entries, totalEntries, truncated: budget.exhausted || entries.length < totalEntries };
}

function formatOutline(outline: OutlineResult, filePath: string): string {
	const name = basename(filePath);
	const header = `[outline for ${name} — ${outline.totalEntries} declaration${outline.totalEntries === 1 ? "" : "s"}]`;
	const body = outline.entries.map((entry) => `${entry.lineNumber}: ${entry.line}`).join("\n");
	const notice = outline.truncated ? "\n\n[Outline truncated. Use ranges to inspect specific declarations.]" : "";
	return `${header}${body ? `\n${body}` : ""}${notice}`;
}

const readRangeSchema = Type.Object({
	start: Type.Integer({ minimum: 1, description: "First line in the requested range (1-indexed)." }),
	end: Type.Optional(Type.Integer({ minimum: 1, description: "Last line in the requested range (inclusive). Defaults to start." })),
	before: Type.Optional(Type.Integer({ minimum: 0, description: "Extra context lines to include before the requested range." })),
	after: Type.Optional(Type.Integer({ minimum: 0, description: "Extra context lines to include after the requested range." })),
});

const readSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Path to the file to read (relative or absolute)" })),
	locations: Type.Optional(Type.String({
		description: "Grep locations to read directly, e.g. 'src/main.ts:12,30-34'. Supports one or more lines. Mutually exclusive with path, offset, limit, ranges, and outline.",
	})),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed). Must be >= 1." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read. Must be >= 1." })),
	ranges: Type.Optional(
		Type.Array(readRangeSchema, {
			minItems: 1,
			description:
				"Explicit line ranges to read. Each range can include before/after context, e.g. { start: 20, end: 40, before: 2, after: 2 }. Mutually exclusive with offset/limit.",
		}),
	),
	outline: Type.Optional(Type.Boolean({ description: "Return only a structural outline (function/class declarations with line numbers). Combine with ranges to also read target sections in one call." })),
	force: Type.Optional(Type.Boolean({ description: "Internal escape hatch." })),
});

function readError(code: string, message: string, hint?: string, details?: Record<string, unknown>): Error {
	return toolError({ tool: "read", code, message, hint, details, retryable: code !== "offset_out_of_range" });
}

function formatOffsetOutOfRangeMessage(offset: number, totalLines: number): string {
	if (totalLines === 0) return `Line ${offset} is beyond end of file (0 lines total). The file is empty.`;
	return `Line ${offset} is beyond end of file (${totalLines} lines total). Use offset=1 to read from the start, or offset=${totalLines} to read the last line.`;
}

function detectImageMimeType(buffer: Buffer): string | undefined {
	if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
	if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
	if (buffer.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
	if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return undefined;
}

async function readImageHeader(path: string): Promise<Buffer> {
	const file = await open(path, "r");
	try {
		const header = Buffer.alloc(12);
		const { bytesRead } = await file.read(header, 0, header.length, 0);
		return header.subarray(0, bytesRead);
	} finally {
		await file.close();
	}
}

async function prepareImage(image: Buffer, mimeType: string): Promise<{ data: string; mimeType: string; note?: string } | undefined> {
	let normalizedImage = image;
	let normalizedMimeType = mimeType;
	if (mimeType === "image/bmp") {
		const converted = await convertToPng(image.toString("base64"), mimeType);
		if (!converted) return undefined;
		normalizedImage = Buffer.from(converted.data, "base64");
		normalizedMimeType = converted.mimeType;
	}

	const resized = await resizeImage(normalizedImage, normalizedMimeType);
	if (!resized) return undefined;
	return { data: resized.data, mimeType: resized.mimeType, note: formatDimensionNote(resized) };
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

function parseReadLocations(locations: string): ReadLocation[] {
	const parsed: ReadLocation[] = [];
	for (const [index, rawLine] of locations.split(/\r?\n/).entries()) {
		const line = rawLine.trim();
		if (!line) continue;
		const match = /^(.*):((?:\d+(?:-\d+)?)(?:,\d+(?:-\d+)?)*)$/.exec(line);
		if (!match || !match[1]) {
			if (line.startsWith("[")) continue;
			throw readError(
				"invalid_locations",
				`Read failed: invalid grep location on line ${index + 1}: ${rawLine}`,
				"Use locations such as 'src/main.ts:12,30-34'.",
				{ line: rawLine },
			);
		}
		const ranges = match[2]!.split(",").map((value) => {
			const [startText, endText] = value.split("-");
			const start = Number(startText);
			const end = endText === undefined ? start : Number(endText);
			return { start, end };
		});
		parsed.push({ path: match[1]!, ranges });
	}
	if (parsed.length === 0) {
		throw readError("invalid_locations", "Read failed: no valid grep locations found.", "Use locations such as 'src/main.ts:12,30-34'.");
	}
	return parsed;
}

function validateReadArguments(
	path: string | undefined,
	locations: string | undefined,
	offset: number | undefined,
	limit: number | undefined,
	ranges: ReadRangeRequest[] | undefined,
	_outline: boolean | undefined,
): void {
	if (!path && !locations) {
		throw readError("invalid_input", "Read failed: path or locations is required.", "Pass path for a normal read, or locations with grep output.");
	}
	if (locations && (path || offset !== undefined || limit !== undefined || ranges !== undefined || _outline)) {
		throw readError(
			"invalid_input",
			"Read failed: locations cannot be combined with path, offset, limit, ranges, or outline.",
			"Pass the grep locations directly as locations, or use path with ranges.",
		);
	}
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

function buildRangeBlocksFromContent(content: string, ranges: NormalizedReadRange[], totalLines: number): CollectedReadRangeBlock[] {
	const blocks = createCollectedRangeBlocks(mergeReadRangeBlocks(ranges, totalLines));
	const budget = createCollectionBudget();
	let blockIndex = 0;
	forEachContentLine(content, (line, lineNumber) => {
		while (blockIndex < blocks.length && lineNumber > blocks[blockIndex]!.requestedDisplayEnd) blockIndex++;
		const block = blocks[blockIndex];
		if (block && lineNumber >= block.requestedDisplayStart) collectBoundedLine(block.lines, { lineNumber, line }, line, budget);
	});
	return blocks;
}

function selectContiguousContent(content: string, startLine: number, limit: number | undefined): { text: string; totalLines: number } {
	const selected: string[] = [];
	const budget = createCollectionBudget();
	const endLine = limit === undefined ? Number.POSITIVE_INFINITY : startLine + limit;
	const totalLines = forEachContentLine(content, (line, lineNumber) => {
		if (lineNumber > startLine && lineNumber <= endLine) collectBoundedLine(selected, line, line, budget);
	});
	return { text: selected.join("\n"), totalLines };
}

function sameFingerprint(a: ReturnType<typeof getDocumentFingerprint>, b: { size: number; mtimeMs: number; ctimeMs: number; ino?: number | bigint }): boolean {
	return a !== undefined && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && String(a.ino ?? "") === String(b.ino ?? "");
}

function createCompleteReadKey(
	offset: number | undefined,
	limit: number | undefined,
	ranges: NormalizedReadRange[] | undefined,
	outline: boolean | undefined,
): string {
	return JSON.stringify({
		offset,
		limit,
		ranges: ranges?.map(({ start, end, before, after }) => ({ start, end, before, after })),
		outline: Boolean(outline),
	});
}

export async function executeRead(
	path: string,
	offset: number | undefined,
	limit: number | undefined,
	signal: AbortSignal | undefined,
	cwd: string,
	ranges?: ReadRangeRequest[],
	outline?: boolean,
	force?: boolean,
): Promise<{ content: Array<TextContent | ImageContent>; details: ReadDetails | undefined }> {
	validateReadArguments(path, undefined, offset, limit, ranges, outline);
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
	if (!fileStat.isFile()) {
		throw readError("not_a_file", `Path is not a regular file: ${path}`, "Choose a regular file.", { path });
	}

	const mimeType = detectImageMimeType(await readImageHeader(absolutePath));
	throwIfAborted(signal);
	if (mimeType) {
		if (fileStat.size > MAX_IMAGE_FILE_BYTES) {
			throw readError(
				"image_too_large",
				`Image is too large to read: ${path} (${formatSize(fileStat.size)}).`,
				"Resize the image before reading it.",
				{ path, size: fileStat.size, maxBytes: MAX_IMAGE_FILE_BYTES },
			);
		}
		const image = await readFile(absolutePath);
		throwIfAborted(signal);
		const snapshotId = createStatRevisionId(fileStat);
		const prepared = await prepareImage(image, mimeType);
		throwIfAborted(signal);
		if (!prepared) {
			return {
				content: [{ type: "text", text: `Read image file [${mimeType}]\n[Image omitted: could not be resized below the inline image size limit.]\nsnapshotId: ${snapshotId}` }],
				details: { snapshotId },
			};
		}
		return {
			content: [
				{ type: "text", text: `Read image file [${prepared.mimeType}]${prepared.note ? `\n${prepared.note}` : ""}\nsnapshotId: ${snapshotId}` },
				{ type: "image", data: prepared.data, mimeType: prepared.mimeType },
			],
			details: { snapshotId },
		};
	}

	// Deduplicate only the same request that previously returned the complete file.
	// A prior full read must never suppress a later ranges/offset read: those calls
	// are intentionally used to inspect a small section of the same unchanged file.
	const completeReadKey = createCompleteReadKey(offset, limit, normalizedRanges, outline);
	const unchangedRevision = !force &&
		sameFingerprint(getDocumentFingerprint(absolutePath), fileStat) &&
		getCompleteDocumentReadKey(absolutePath) === completeReadKey
		? getCurrentDocumentRevision(absolutePath)
		: undefined;
	if (unchangedRevision && !outline) {
		return {
			content: [{ type: "text", text: `Content unchanged since your last read (snapshotId: ${unchangedRevision}). Content is already in your context. Use force=true only if you need to re-read.` }],
			details: { snapshotId: unchangedRevision },
		};
	}

	if (fileStat.size > MAX_TEXT_FILE_BYTES) {
		throw readError(
			"file_too_large",
			`File is too large to read as text: ${path} (${formatSize(fileStat.size)}).`,
			"Use grep, shell tools, or another tool to inspect a smaller portion.",
			{ path, size: fileStat.size, maxBytes: MAX_TEXT_FILE_BYTES },
		);
	}

	const buffer = await readFile(absolutePath);
	throwIfAborted(signal);
	detectBinaryContent(buffer, path);
	const rawContent = buffer.toString("utf-8");
	const snapshotId = createRevisionId(rawContent);
	const totalFileLines = forEachContentLine(rawContent, () => {});
	const contentLineCount = rawContent.endsWith("\n") ? Math.max(0, totalFileLines - 1) : totalFileLines;

	// Only a read that returned the complete file seeds dedup metadata. The revision
	// itself is retained without caching another full copy of the file content.
	const seedsFingerprint = (() => {
		if (outline && !normalizedRanges) return false;
		if (normalizedRanges) {
			const merged = mergeReadRangeBlocks(normalizedRanges, totalFileLines);
			return merged.length === 1 && merged[0]!.displayStart <= 1 && merged[0]!.displayEnd >= contentLineCount;
		}
		const startLine = offset ? offset - 1 : 0;
		return startLine === 0 && (limit === undefined || limit >= contentLineCount);
	})();
	rememberDocumentRevision(absolutePath, snapshotId, seedsFingerprint ? fileStat : undefined, seedsFingerprint ? completeReadKey : undefined);

	if (outline) {
		const outlineText = formatOutline(buildOutline(rawContent, path), path);
		if (!normalizedRanges) {
			return { content: [{ type: "text", text: buildReadResponseText(outlineText, snapshotId) }], details: { snapshotId } };
		}
		if (unchangedRevision) {
			const dedupMsg = `Ranges content unchanged since your last read (snapshotId: ${unchangedRevision}). Content is already in your context. Use force=true only if you need to re-read.`;
			return { content: [{ type: "text", text: `${outlineText}\n\n---\n${dedupMsg}` }], details: { snapshotId: unchangedRevision } };
		}
		const rangeResult = finalizeRangeReadResult(buildRangeBlocksFromContent(rawContent, normalizedRanges, totalFileLines), normalizedRanges, totalFileLines, snapshotId);
		return { content: [{ type: "text", text: `${outlineText}\n\n---\n${rangeResult.content[0]!.text}` }], details: rangeResult.details };
	}

	if (normalizedRanges) return finalizeRangeReadResult(buildRangeBlocksFromContent(rawContent, normalizedRanges, totalFileLines), normalizedRanges, totalFileLines, snapshotId);

	const startLine = offset ? offset - 1 : 0;
	if (offset !== undefined && startLine >= totalFileLines) return buildOffsetOutOfRangeResult(offset, totalFileLines, snapshotId);
	const selected = selectContiguousContent(rawContent, startLine, limit);
	return finalizeContiguousReadResult(selected.text, snapshotId, startLine, selected.totalLines, limit);
}

async function executeReadLocations(
	locations: string,
	signal: AbortSignal | undefined,
	cwd: string,
	force?: boolean,
): Promise<{ content: TextContent[]; details: ReadDetails | undefined }> {
	const parsed = parseReadLocations(locations);
	const parts: string[] = [];
	const snapshots: Record<string, string> = {};
	for (const location of parsed) {
		const result = await executeRead(location.path, undefined, undefined, signal, cwd, location.ranges, undefined, force);
		const text = result.content
			.filter((item): item is TextContent => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		if (text) parts.push(`[${location.path}]\n${text}`);
		const snapshotId = result.details?.snapshotId;
		if (snapshotId) snapshots[location.path] = snapshotId;
	}
	return {
		content: [{ type: "text", text: parts.join("\n\n") || "No locations found" }],
		details: Object.keys(snapshots).length > 0 ? { snapshots } : undefined,
	};
}

export function registerReadTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read",
		label: "read",
		description: `Read text files and images up to ${MAX_TEXT_FILE_BYTES / (1024 * 1024)}MB (jpg, png, gif, webp, bmp). Images are sent as attachments. Text output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Use offset/limit for large files, ranges for explicit line windows, or locations to read grep output directly.`,
		promptSnippet: "Read file contents",
		promptGuidelines: [
			"Read is the primary way to inspect file contents. When the user names a file or you need its text, read it directly — don't grep or find first.",
			"Every read returns a snapshotId — copy it to your next edit. After editing, the result gives a new snapshotId; use that directly, no re-read needed.",
			"Use ranges for specific line windows; when grep returns file:line or file:start-end locations, pass the complete grep output as locations, or convert it to ranges. Use outline=true to discover file structure (declarations + line numbers). Combine both in one call to see structure and read key sections simultaneously.",
			"Re-reading the same file with the same parameters returns a cached result. Only re-read when edit signals stale_snapshot or ambiguous match.",
		],
		parameters: readSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { path, locations, offset, limit, ranges, outline, force } = params as {
				path?: string;
				locations?: string;
				offset?: number;
				limit?: number;
				ranges?: ReadRangeRequest[];
				outline?: boolean;
				force?: boolean;
			};
			const cwd = ctx?.cwd ?? process.cwd();
			if (locations !== undefined) return executeReadLocations(locations, signal, cwd, force);
			return executeRead(path!, offset, limit, signal, cwd, ranges, outline, force);
		},
	});
}
