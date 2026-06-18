import {
	createGrepToolDefinition,
	type ExtensionAPI,
	type GrepToolDetails,
	DEFAULT_MAX_BYTES,
	formatSize,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import { GrepOutputMode, grep, type GrepMatch } from "./omp-native.ts";
import { basename } from "node:path";
import { stat } from "node:fs/promises";
import { normalizePath } from "./shared.ts";

const builtInGrep = createGrepToolDefinition(process.cwd());
const DEFAULT_LIMIT = 100;
const SEARCH_TIMEOUT_MS = 30_000;
const GREP_MAX_LINE_LENGTH = 500; // ponytail: match pi built-in truncate width without depending on an internal runtime export

function escapeRegex(pattern: string): string {
	return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeLine(line: string): string {
	return line.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
}

function formatMatchPath(matchPath: string, isDirectory: boolean, searchPath: string): string {
	return isDirectory ? matchPath.replace(/\\/g, "/") : basename(searchPath).replace(/\\/g, "/");
}

function pushMatchBlock(outputLines: string[], pathText: string, match: GrepMatch, contextValue: number): boolean {
	let linesTruncated = Boolean(match.truncated);
	if (contextValue <= 0) {
		const sanitized = sanitizeLine(match.line ?? "");
		const truncated = truncateLine(sanitized, GREP_MAX_LINE_LENGTH);
		outputLines.push(`${pathText}:${match.lineNumber}: ${truncated.text}`);
		return linesTruncated || truncated.wasTruncated;
	}
	for (const before of match.contextBefore ?? []) {
		const sanitized = sanitizeLine(before.line);
		const truncated = truncateLine(sanitized, GREP_MAX_LINE_LENGTH);
		outputLines.push(`${pathText}-${before.lineNumber}- ${truncated.text}`);
		linesTruncated = linesTruncated || truncated.wasTruncated;
	}
	const matchLine = truncateLine(sanitizeLine(match.line ?? ""), GREP_MAX_LINE_LENGTH);
	outputLines.push(`${pathText}:${match.lineNumber}: ${matchLine.text}`);
	linesTruncated = linesTruncated || matchLine.wasTruncated;
	for (const after of match.contextAfter ?? []) {
		const sanitized = sanitizeLine(after.line);
		const truncated = truncateLine(sanitized, GREP_MAX_LINE_LENGTH);
		outputLines.push(`${pathText}-${after.lineNumber}- ${truncated.text}`);
		linesTruncated = linesTruncated || truncated.wasTruncated;
	}
	return linesTruncated;
}

export async function executeGrepNative(
	pattern: string,
	searchDir: string | undefined,
	globPattern: string | undefined,
	ignoreCase: boolean | undefined,
	literal: boolean | undefined,
	context: number | undefined,
	limit: number | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: GrepToolDetails }> {
	const searchPath = normalizePath(searchDir || ".", cwd);
	let isDirectory: boolean;
	try {
		isDirectory = (await stat(searchPath)).isDirectory();
	} catch {
		throw new Error(`Path not found: ${searchPath}`);
	}

	const contextValue = context && context > 0 ? context : 0;
	const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
	const nativePattern = literal ? escapeRegex(pattern) : pattern;

	let result;
	try {
		result = await grep({
			pattern: nativePattern,
			path: searchPath,
			glob: globPattern,
			ignoreCase,
			hidden: true,
			gitignore: true,
			maxCount: effectiveLimit,
			contextBefore: contextValue,
			contextAfter: contextValue,
			maxColumns: GREP_MAX_LINE_LENGTH,
			mode: GrepOutputMode.Content,
			signal,
			timeoutMs: SEARCH_TIMEOUT_MS,
		});
	} catch (err) {
		if (err instanceof Error && /^regex(?: parse)? error/i.test(err.message)) {
			throw new Error(err.message.replace(/^regex(?: parse)? error:?\s*/i, "Invalid regex: "));
		}
		if (err instanceof Error && err.message.includes("Aborted: Timeout")) {
			throw new Error(`Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s; narrow paths or pattern`);
		}
		throw err;
	}

	if (result.matches.length === 0) {
		return { content: [{ type: "text", text: "No matches found" }], details: undefined };
	}

	const outputLines: string[] = [];
	let linesTruncated = false;
	for (const match of result.matches) {
		const pathText = formatMatchPath(match.path, isDirectory, searchPath);
		linesTruncated = pushMatchBlock(outputLines, pathText, match, contextValue) || linesTruncated;
	}

	const rawOutput = outputLines.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let text = truncation.content;
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	if (result.limitReached) {
		notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
		details.matchLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		details.linesTruncated = true;
	}
	if ((result.skippedOversized ?? 0) > 0) {
		notices.push(`Skipped ${result.skippedOversized} oversized file(s)`);
	}
	if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
	return { content: [{ type: "text", text }], details: Object.keys(details).length > 0 ? details : undefined };
}

export function registerGrepTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...builtInGrep,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { pattern, path: searchDir, glob, ignoreCase, literal, context, limit } = params as {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			};
			return executeGrepNative(
				pattern,
				searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
				ctx?.cwd ?? process.cwd(),
				signal,
			);
		},
	});
}
