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

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed). Must be >= 1." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read. Must be >= 1." })),
	withHashlines: Type.Optional(
		Type.Boolean({
			description:
				"If true, each line is prefixed with LINE:SHORT_HASH| for hashline anchoring in subsequent edits. Default: false.",
		}),
	),
});

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
				const outputText = withHashlines
					? outputLines.map((line, i) => `${startLine + i + 1}:${shortHash(line)}|${line}`).join("\n")
					: joinContentLines(outputLines, false);
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

				resolve({ content: [{ type: "text", text: finalText }], details });
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
): Promise<{ content: TextContent[]; details: ReadToolDetails | undefined }> {
	const absolutePath = normalizePath(path, cwd);
	await ensureReadable(path, absolutePath);
	throwIfAborted(signal);

	const fileStat = await stat(absolutePath);
	if (fileStat.size > STREAMING_THRESHOLD) {
		return executeReadStreaming(absolutePath, path, offset, limit, withHashlines, fileStat, signal);
	}

	const buffer = await readFile(absolutePath);
	throwIfAborted(signal);

	const { lines: fileLines, endsWithNewline } = splitContentLines(buffer.toString("utf-8"));
	const allLines = endsWithNewline ? fileLines.concat("") : fileLines;
	const totalFileLines = allLines.length;
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	if (startLine >= allLines.length) {
		throw readError(
			"offset_out_of_range",
			`Offset ${offset} is beyond end of file (${allLines.length} lines total)`,
			"Use a smaller offset or reread the file from the beginning.",
			{ path, offset, totalLines: allLines.length },
		);
	}

	const selectedLines = limit !== undefined ? allLines.slice(startLine, startLine + limit) : allLines.slice(startLine);
	const outputText = withHashlines
		? selectedLines.map((line, i) => `${startLine + i + 1}:${shortHash(line)}|${line}`).join("\n")
		: selectedLines.join("\n");
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

	return { content: [{ type: "text", text: finalText }], details };
}

export function registerReadTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read",
		label: "read (hashline-enhanced)",
		description: `Read the contents of a file with hashline support. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Use offset/limit for large files. Set withHashlines=true to get LINE:HASH|prefix for each line. Large files (>5MB) are streamed to avoid OOM.`,
		promptSnippet: "Read file contents with hashline support",
		promptGuidelines: [
			"Use read when the user wants file contents or you need the exact current text.",
			"If the user already named the file but wants search, counts, or a direct unique replacement, use grep or edit instead of reading first.",
			"Use withHashlines=true before hashline-anchored edits to capture fresh LINE:HASH prefixes.",
		],
		parameters: readSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { path, offset, limit, withHashlines } = params as {
				path: string;
				offset?: number;
				limit?: number;
				withHashlines?: boolean;
			};
			return executeRead(path, offset, limit, withHashlines, signal, ctx?.cwd ?? process.cwd());
		},
	});
}
