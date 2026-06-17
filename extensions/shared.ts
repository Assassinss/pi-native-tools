import type { TextContent } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile as fsWriteFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

export type { TextContent } from "@earendil-works/pi-ai";
export {
	constants,
	createReadStream,
	createWriteStream,
	access,
	mkdir,
	readFile,
	stat,
	fsWriteFile,
	basename,
	dirname,
	resolve,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	withFileMutationQueue,
};

export const STREAMING_THRESHOLD = 5 * 1024 * 1024;
export const WRITE_CHUNK_SIZE = 64 * 1024;
export const HASH_SHORT_LEN = 8;
export const STREAM_READ_CHUNK_SIZE = 256 * 1024;

export type LineContent = {
	lines: string[];
	endsWithNewline: boolean;
};

export function splitContentLines(content: string): LineContent {
	if (content.length === 0) return { lines: [], endsWithNewline: false };
	const endsWithNewline = content.endsWith("\n");
	const normalized = endsWithNewline ? content.slice(0, -1) : content;
	return {
		lines: normalized.split("\n"),
		endsWithNewline,
	};
}

export function joinContentLines(lines: string[], endsWithNewline: boolean): string {
	if (lines.length === 0) return "";
	return `${lines.join("\n")}${endsWithNewline ? "\n" : ""}`;
}

export function shortHash(content: string, len: number = HASH_SHORT_LEN): string {
	return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, len);
}

export function fullHash(content: string | Buffer): string {
	if (typeof content === "string") {
		return createHash("sha256").update(content, "utf-8").digest("hex");
	}
	return createHash("sha256").update(content).digest("hex");
}

export function normalizePath(path: string, cwd: string): string {
	let p = path;
	if (p.startsWith("@")) p = p.slice(1);
	return resolve(cwd, p);
}

export async function ensureReadable(path: string, absolutePath: string): Promise<void> {
	try {
		await access(absolutePath, constants.R_OK);
	} catch (err: any) {
		if (err.code === "ENOENT") throw new Error(`File not found: ${path}`);
		if (err.code === "EACCES") throw new Error(`Permission denied: ${path}`);
		throw new Error(`Cannot access file: ${path}. ${err.message}`);
	}
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted");
}

export function successText(text: string): TextContent[] {
	return [{ type: "text", text }];
}
