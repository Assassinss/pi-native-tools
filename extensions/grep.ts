import {
	createGrepToolDefinition,
	type ExtensionAPI,
	type GrepToolDetails,
	DEFAULT_MAX_BYTES,
	formatSize,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GrepOutputMode, grep, type GrepMatch } from "./omp-native.ts";
import { basename } from "node:path";
import { stat } from "node:fs/promises";
import { normalizePath, toolError } from "./shared.ts";

function grepError(code: string, message: string, hint?: string, details?: Record<string, unknown>): Error {
	return toolError({ tool: "grep", code, message, hint, details });
}

const builtInGrep = createGrepToolDefinition(process.cwd());
const DEFAULT_LIMIT = 100;
const SEARCH_TIMEOUT_MS = 30_000;
const GREP_MAX_LINE_LENGTH = 500; // ponytail: match pi built-in truncate width without depending on an internal runtime export
const grepSchema = Type.Object(
	{
		pattern: Type.String({ description: "Search pattern (regex by default, or exact text when literal=true). Use for code/content search, not path discovery." }),
		path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
		glob: Type.Optional(Type.String({ description: "Optional file filter such as '*.ts' or '**/*.spec.ts'. Applies after choosing the search path." })),
		ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
		literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal text instead of regex. Prefer true for exact strings containing regex characters like ()[]?." })),
		context: Type.Optional(Type.Integer({ minimum: 0, description: "Number of lines to show before and after each match (default: 0). Must be >= 0." })),
		limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of matches to return (default: 100). Must be >= 1." })),
		mode: Type.Optional(
			Type.Union([
				Type.Literal("content"),
				Type.Literal("count"),
				Type.Literal("filesWithMatches"),
			], {
				description: "Output mode: content for matching lines, count for per-file match totals, or filesWithMatches for path-only results.",
			}),
		),
	},
	{ additionalProperties: false },
);

type GrepMode = "content" | "count" | "filesWithMatches";
type GrepUpdate = { content: Array<{ type: "text"; text: string }>; details?: GrepToolDetails };

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

function resolveNativeMode(mode: GrepMode | undefined): GrepOutputMode {
	switch (mode) {
		case "count":
			return GrepOutputMode.Count;
		case "filesWithMatches":
			return GrepOutputMode.FilesWithMatches;
		default:
			return GrepOutputMode.Content;
	}
}

function formatGrepOutput(mode: GrepMode, matches: GrepMatch[], isDirectory: boolean, searchPath: string, contextValue: number) {
	if (mode === "count") {
		return {
			text: matches.map((match) => `${formatMatchPath(match.path, isDirectory, searchPath)}: ${match.matchCount ?? 0}`).join("\n"),
			linesTruncated: false,
		};
	}
	if (mode === "filesWithMatches") {
		return {
			text: matches.map((match) => formatMatchPath(match.path, isDirectory, searchPath)).join("\n"),
			linesTruncated: false,
		};
	}

	const outputLines: string[] = [];
	let linesTruncated = false;
	for (const match of matches) {
		const pathText = formatMatchPath(match.path, isDirectory, searchPath);
		linesTruncated = pushMatchBlock(outputLines, pathText, match, contextValue) || linesTruncated;
	}
	return { text: outputLines.join("\n"), linesTruncated };
}

function formatLimitNotice(mode: GrepMode, effectiveLimit: number): string {
	if (mode === "content") return `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`;
	return `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`;
}

function buildGrepResponse(
	mode: GrepMode,
	matches: GrepMatch[],
	isDirectory: boolean,
	searchPath: string,
	contextValue: number,
	result?: { limitReached?: boolean; skippedOversized?: number },
	effectiveLimit?: number,
): GrepUpdate {
	if (matches.length === 0) {
		return { content: [{ type: "text", text: "No matches found" }], details: undefined };
	}

	const formatted = formatGrepOutput(mode, matches, isDirectory, searchPath, contextValue);
	const truncation = truncateHead(formatted.text, { maxLines: Number.MAX_SAFE_INTEGER });
	let text = truncation.content;
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	if (result?.limitReached && effectiveLimit !== undefined) {
		notices.push(formatLimitNotice(mode, effectiveLimit));
		details.matchLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (formatted.linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		details.linesTruncated = true;
	}
	if ((result?.skippedOversized ?? 0) > 0) {
		notices.push(`Skipped ${result?.skippedOversized} oversized file(s)`);
	}
	if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
	return { content: [{ type: "text", text }], details: Object.keys(details).length > 0 ? details : undefined };
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
	mode: GrepMode | undefined,
	onUpdate?: (update: GrepUpdate) => void,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: GrepToolDetails }> {
	const searchPath = normalizePath(searchDir || ".", cwd);
	let isDirectory: boolean;
	try {
		isDirectory = (await stat(searchPath)).isDirectory();
	} catch {
		throw grepError("path_not_found", `Path not found: ${searchPath}`, "Check the search path and retry.", { path: searchPath });
	}

	const grepMode = mode ?? "content";
	const contextValue = context && context > 0 ? context : 0;
	const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
	const nativePattern = literal ? escapeRegex(pattern) : pattern;

	let result;
	try {
		result = await grep(
			{
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
				mode: resolveNativeMode(grepMode),
				signal,
				timeoutMs: SEARCH_TIMEOUT_MS,
			},
			(error, match) => {
				if (error || !match) return;
			},
		);
	} catch (err) {
		if (err instanceof Error && /^regex(?: parse)? error/i.test(err.message)) {
			const message = err.message.replace(/^regex(?: parse)? error:?\s*/i, "Invalid regex: ");
			throw grepError("invalid_regex", message, "Use literal=true for exact text or fix the regex syntax.", { pattern, literal: Boolean(literal) });
		}
		if (err instanceof Error && err.message.includes("Aborted: Timeout")) {
			throw grepError(
				"search_timeout",
				`Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s; narrow paths or pattern`,
				"Reduce the search path, add a glob filter, or make the pattern more specific.",
				{ path: searchPath, pattern },
			);
		}
		throw err;
	}

	if (result.matches.length === 0) {
		return { content: [{ type: "text", text: "No matches found" }], details: undefined };
	}

	return buildGrepResponse(grepMode, result.matches, isDirectory, searchPath, contextValue, result, effectiveLimit);
}

export function registerGrepTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...builtInGrep,
		description:
			"Search file contents by regex or literal pattern. Use this when you need matching lines, counts, or files with matches. Prefer find for path discovery, read for full file inspection, and bash only for shell-specific tasks. Respects .gitignore and truncates long lines in output.",
		promptSnippet: "Search file contents without falling back to bash grep",
		promptGuidelines: [
			"Use grep to search file contents for symbols, strings, definitions, counts, or files with matches.",
			"If the user already named the file or directory to search, grep it directly; do not read first unless they asked to inspect content.",
			"Use literal=true for exact code snippets, function calls, or text containing regex metacharacters like ()[]{}?.+*.",
			"Use mode=count for totals and mode=filesWithMatches for file-name-only results.",
		],
		parameters: grepSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { pattern, path: searchDir, glob, ignoreCase, literal, context, limit, mode } = params as {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
				mode?: GrepMode;
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
				mode,
				onUpdate as any,
			);
		},
	});
}

