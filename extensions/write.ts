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
} from "./shared.ts";
import { createHash } from "node:crypto";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

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
		if (err.code === "EACCES") throw new Error(`Permission denied creating directory: ${dir}`);
		throw new Error(`Failed to create directory ${dir}: ${err.message}`);
	}

	throwIfAborted(signal);
	const contentSize = Buffer.byteLength(content, "utf-8");

	if (contentSize < STREAMING_THRESHOLD) {
		return withFileMutationQueue(absolutePath, async () => {
			throwIfAborted(signal);
			try {
				await fsWriteFile(absolutePath, content, "utf-8");
			} catch (err: any) {
				if (err.code === "EACCES") throw new Error(`Permission denied writing: ${path}`);
				if (err.code === "ENOSPC") throw new Error(`Disk full: cannot write ${formatSize(contentSize)} to ${path}`);
				throw new Error(`Failed to write ${path}: ${err.message}`);
			}
			throwIfAborted(signal);
			const writtenStat = await stat(absolutePath);
			const writtenHash = fullHash(content);
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
		let bytesWritten = 0;

		return new Promise<{ content: TextContent[]; details: { size: number; hash: string } }>((resolve, reject) => {
			let writeStream = createWriteStream(absolutePath, {
				highWaterMark: WRITE_CHUNK_SIZE,
			});

			const onAbort = () => {
				writeStream.destroy();
				reject(new Error("Operation aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			writeStream.on("error", (err: NodeJS.ErrnoException) => {
				signal?.removeEventListener("abort", onAbort);
				if (err.code === "EACCES") reject(new Error(`Permission denied writing: ${path}`));
				else if (err.code === "ENOSPC") reject(new Error(`Disk full: streaming write failed for ${path}`));
				else reject(new Error(`Streaming write failed for ${path}: ${err.message}`));
			});

			writeStream.on("finish", async () => {
				signal?.removeEventListener("abort", onAbort);
				try {
					const fileHash = hash.digest("hex");
					const writtenStat = await stat(absolutePath);
					if (writtenStat.size !== bytesWritten) {
						reject(
							new Error(
								`Write verification failed for ${path}: expected ${bytesWritten} bytes, got ${writtenStat.size} bytes. File may be corrupt.`,
							),
						);
						return;
					}
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
					reject(new Error(`Write verification failed for ${path}: ${err.message}`));
				}
			});

			const buffer = Buffer.from(content, "utf-8");
			let offset = 0;

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
				const shouldContinue = writeStream.write(chunk);
				if (!shouldContinue) writeStream.once("drain", writeNextChunk);
				else setImmediate(writeNextChunk);
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
			"Use write for new files or complete rewrites.",
			"For large files (5MB+), write streams content in 64KB chunks to prevent OOM.",
		],
		parameters: writeSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { path, content } = params as { path: string; content: string };
			return executeWrite(path, content, signal, ctx?.cwd ?? process.cwd());
		},
	});
}
