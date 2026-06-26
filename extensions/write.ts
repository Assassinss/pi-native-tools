import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "./shared.ts";
import { Type } from "typebox";
import {
	STREAMING_THRESHOLD,
	WRITE_CHUNK_SIZE,
	createWriteStream,
	dirname,
	formatSize,
	fsWriteFile,
	fullHash,
	mkdir,
	normalizePath,
	stat,
	throwIfAborted,
	withFileMutationQueue,
	toolError,
} from "./shared.ts";

function writeError(code: string, message: string, hint?: string, details?: Record<string, unknown>): Error {
	return toolError({ tool: "write", code, message, hint, details });
}
import { createHash } from "node:crypto";
import { invalidateFsScanCache } from "./omp-native.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

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

function invalidateScanCache(absolutePath: string, dir: string): void {
	invalidateFsScanCache?.(absolutePath);
	invalidateFsScanCache?.(dir);
}

export async function executeWrite(
	path: string,
	content: string,
	signal: AbortSignal | undefined,
	cwd: string,
): Promise<{ content: TextContent[]; details: { size: number; hash: string } | undefined }> {
	const absolutePath = normalizePath(path, cwd);
	const dir = dirname(absolutePath);

	try {
		await mkdir(dir, { recursive: true });
	} catch (err: any) {
		if (err.code === "EACCES") {
			throw writeError("permission_denied_directory", `Permission denied creating directory: ${dir}`, "Choose a writable parent directory or adjust permissions.", { path: dir });
		}
		throw writeError("mkdir_failed", `Failed to create directory ${dir}: ${err.message}`, undefined, { path: dir });
	}

	throwIfAborted(signal);
	const contentSize = Buffer.byteLength(content, "utf-8");

	if (contentSize < STREAMING_THRESHOLD) {
		return withFileMutationQueue(absolutePath, async () => {
			throwIfAborted(signal);
			const contentBuffer = Buffer.from(content, "utf-8");
			try {
				await fsWriteFile(absolutePath, contentBuffer);
			} catch (err: any) {
				if (err.code === "EACCES") {
					throw writeError("permission_denied_write", `Permission denied writing: ${path}`, "Choose a writable path or adjust permissions.", { path });
				}
				if (err.code === "ENOSPC") {
					throw writeError("disk_full", `Disk full: cannot write ${formatSize(contentSize)} to ${path}`, "Free disk space and retry the write.", { path, sizeBytes: contentSize });
				}
				throw writeError("write_failed", `Failed to write ${path}: ${err.message}`, undefined, { path });
			}
			throwIfAborted(signal);
			const writtenStat = await stat(absolutePath);
			const writtenHash = fullHash(contentBuffer);
			invalidateScanCache(absolutePath, dir);
			return {
				content: [
					{
						type: "text",
						text: `Successfully wrote ${formatSize(contentSize)} to ${path} (verified: ${writtenStat.size} bytes, SHA256: ${writtenHash.slice(0, 16)}...).`,
					},
				],
				details: { size: writtenStat.size, hash: writtenHash },
			};
		});
	}

	return withFileMutationQueue(absolutePath, async () => {
		throwIfAborted(signal);
		const hash = createHash("sha256");

		return new Promise<{ content: TextContent[]; details: { size: number; hash: string } }>((resolve, reject) => {
			let writeStream = createWriteStream(absolutePath, {
				highWaterMark: WRITE_CHUNK_SIZE,
			});

			const onAbort = () => {
				writeStream.destroy();
				reject(writeError("aborted", "Operation aborted", "Retry the write if cancellation was unintended.", { path }));
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			writeStream.on("error", (err: NodeJS.ErrnoException) => {
				signal?.removeEventListener("abort", onAbort);
				if (err.code === "EACCES") reject(writeError("permission_denied_write", `Permission denied writing: ${path}`, "Choose a writable path or adjust permissions.", { path }));
				else if (err.code === "ENOSPC") reject(writeError("disk_full", `Disk full: streaming write failed for ${path}`, "Free disk space and retry the write.", { path }));
				else reject(writeError("stream_write_failed", `Streaming write failed for ${path}: ${err.message}`, undefined, { path }));
			});

			writeStream.on("finish", async () => {
				signal?.removeEventListener("abort", onAbort);
				try {
					const fileHash = hash.digest("hex");
					const writtenStat = await stat(absolutePath);
					if (writtenStat.size !== contentSize) {
						reject(
							writeError(
								"verification_failed",
								`Write verification failed for ${path}: expected ${contentSize} bytes, got ${writtenStat.size} bytes. File may be corrupt.`,
								"Retry the write and inspect the filesystem if the mismatch persists.",
								{ path, expectedSize: contentSize, actualSize: writtenStat.size },
							),
						);
						return;
					}
					invalidateScanCache(absolutePath, dir);
					resolve({
						content: [
							{
								type: "text",
								text: `Successfully wrote ${formatSize(contentSize)} to ${path} via streaming (verified: ${writtenStat.size} bytes, SHA256: ${fileHash.slice(0, 16)}...).`,
							},
						],
						details: { size: writtenStat.size, hash: fileHash },
					});
				} catch (err: any) {
					reject(writeError("verification_failed", `Write verification failed for ${path}: ${err.message}`, undefined, { path }));
				}
			});

			let offset = 0;

			const writeNextChunk = () => {
				while (offset < content.length) {
					const end = getSafeChunkEnd(content, offset, WRITE_CHUNK_SIZE);
					const chunk = content.slice(offset, end);
					const chunkBuffer = Buffer.from(chunk, "utf-8");
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
	});
}

export function registerWriteTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "write",
		label: "write (streaming)",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories. For files >5MB, uses streaming chunked writes to avoid OOM. After writing, verifies file integrity via file size and SHA256 hash.",
		promptSnippet: "Create or overwrite files with streaming support",
		promptGuidelines: [
			"Use write for new files or replacing the full contents of a file in one shot.",
			"Use edit instead when changing only part of an existing file, and do not use bash redirection for simple file creation or overwrites.",
		],
		parameters: writeSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { path, content } = params as { path: string; content: string };
			return executeWrite(path, content, signal, ctx?.cwd ?? process.cwd());
		},
	});
}
