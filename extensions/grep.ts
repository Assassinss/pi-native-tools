import {
	createGrepToolDefinition,
	type ExtensionAPI,
	type GrepToolDetails,
	formatSize,
	truncateHead,
	truncateLine,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
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
// Keep tool results compact; callers can raise `limit` when more matches are needed.
const MODEL_MAX_BYTES = 8 * 1024;
const MODEL_MAX_LINES = 250;
const NOTICE_RESERVE_BYTES = 1024;
const NOTICE_RESERVE_LINES = 2;
const MAX_MATCHES_PER_FILE = 8;
const MAX_MATCH_FILES = 40;
const MAX_MATCHES = 120;
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

type GrepParams = Static<typeof grepSchema>;
type GrepMode = NonNullable<GrepParams["mode"]>;
type GrepUpdate = { content: Array<{ type: "text"; text: string }>; details: GrepToolDetails | undefined };

export interface ExecuteGrepOptions extends GrepParams {
	cwd: string;
	signal?: AbortSignal;
}

function escapeRegex(pattern: string): string {
	return pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizeLine(line: string): string {
	return line.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
}

function formatMatchPath(matchPath: string, isDirectory: boolean, searchPath: string): string {
	return isDirectory ? matchPath.replace(/\\/g, "/") : basename(searchPath).replace(/\\/g, "/");
}

type OutputLine = { line: string; isMatch: boolean; nativeTruncated: boolean };

function collectContentLines(matches: GrepMatch[], contextValue: number): Map<string, Map<number, OutputLine>> {
	const files = new Map<string, Map<number, OutputLine>>();
	for (const match of matches) {
		const lines = files.get(match.path) ?? new Map<number, OutputLine>();
		files.set(match.path, lines);
		if (contextValue > 0) {
			for (const contextLine of [...(match.contextBefore ?? []), ...(match.contextAfter ?? [])]) {
				if (!lines.has(contextLine.lineNumber)) {
					lines.set(contextLine.lineNumber, { line: contextLine.line, isMatch: false, nativeTruncated: false });
				}
			}
		}
		lines.set(match.lineNumber, {
			line: match.line ?? "",
			isMatch: true,
			nativeTruncated: Boolean(match.truncated),
		});
	}
	return files;
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
	for (const [matchPath, lines] of collectContentLines(matches, contextValue)) {
		const pathText = formatMatchPath(matchPath, isDirectory, searchPath);
		for (const [lineNumber, outputLine] of [...lines].sort(([a], [b]) => a - b)) {
			const truncated = truncateLine(sanitizeLine(outputLine.line), GREP_MAX_LINE_LENGTH);
			const separator = outputLine.isMatch ? ":" : "-";
			outputLines.push(`${pathText}${separator}${lineNumber}${separator} ${truncated.text}`);
			linesTruncated = linesTruncated || outputLine.nativeTruncated || truncated.wasTruncated;
		}
	}
	return { text: outputLines.join("\n"), linesTruncated };
}

function formatLimitNotice(mode: GrepMode, effectiveLimit: number): string {
	if (mode === "content") return `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`;
	return `${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`;
}

function limitContentMatches(matches: GrepMatch[]): { matches: GrepMatch[]; omitted: number; omittedFiles: number } {
	const perFile = new Map<string, number>();
	const files = new Set<string>();
	const limited: GrepMatch[] = [];
	let omitted = 0;
	const omittedFiles = new Set<string>();

	for (const match of matches) {
		const fileMatches = perFile.get(match.path) ?? 0;
		if (limited.length >= MAX_MATCHES || (!files.has(match.path) && files.size >= MAX_MATCH_FILES) || fileMatches >= MAX_MATCHES_PER_FILE) {
			omitted++;
			omittedFiles.add(match.path);
			continue;
		}
		files.add(match.path);
		perFile.set(match.path, fileMatches + 1);
		limited.push(match);
	}
	return { matches: limited, omitted, omittedFiles: omittedFiles.size };
}

function buildGrepResponse(
	mode: GrepMode,
	matches: GrepMatch[],
	isDirectory: boolean,
	searchPath: string,
	contextValue: number,
	result?: {
		limitReached?: boolean;
		skippedOversized?: number;
		totalMatches?: number;
		filesWithMatches?: number;
	},
	effectiveLimit?: number,
): GrepUpdate {
	const limited = mode === "content" ? limitContentMatches(matches) : { matches, omitted: 0, omittedFiles: 0 };
	const formatted = formatGrepOutput(mode, limited.matches, isDirectory, searchPath, contextValue);
	const truncation = truncateHead(formatted.text, {
		maxBytes: MODEL_MAX_BYTES - NOTICE_RESERVE_BYTES,
		maxLines: MODEL_MAX_LINES - NOTICE_RESERVE_LINES,
	});
	let text = truncation.content || "No matches found";
	const details: GrepToolDetails = {};
	const notices: string[] = [];
	const nativeOmitted = mode === "content" ? Math.max(0, (result?.totalMatches ?? matches.length) - matches.length) : 0;
	const userLimitReached = Boolean(result?.limitReached && effectiveLimit !== undefined && (result?.totalMatches ?? 0) >= effectiveLimit);
	if (userLimitReached && effectiveLimit !== undefined) {
		notices.push(formatLimitNotice(mode, effectiveLimit));
		details.matchLimitReached = effectiveLimit;
	}
	const omitted = limited.omitted + nativeOmitted;
	if (omitted > 0) {
		const matchesPerFile = new Map<string, number>();
		for (const match of matches) matchesPerFile.set(match.path, (matchesPerFile.get(match.path) ?? 0) + 1);
		const filesAtPerFileLimit = [...matchesPerFile.values()].filter((count) => count >= MAX_MATCHES_PER_FILE).length;
		const omittedFiles = Math.max(limited.omittedFiles, filesAtPerFileLimit, result?.filesWithMatches && matches.length === 0 ? result.filesWithMatches : 0);
		const qualifier = nativeOmitted > 0 ? "At least " : "";
		const matchLabel = omitted === 1 ? "match" : "matches";
		const fileLabel = omittedFiles === 1 ? "file" : "files";
		notices.push(`${qualifier}${omitted} ${matchLabel} in ${omittedFiles} ${fileLabel} omitted (max ${MAX_MATCHES_PER_FILE}/file, ${MAX_MATCH_FILES} files, ${MAX_MATCHES} matches)`);
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(MODEL_MAX_BYTES)} or ${MODEL_MAX_LINES} lines limit reached`);
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

export async function executeGrepNative({
	pattern,
	path: searchDir,
	glob: globPattern,
	ignoreCase,
	literal,
	context,
	limit,
	cwd,
	signal,
	mode,
}: ExecuteGrepOptions): Promise<GrepUpdate> {
	const searchPath = normalizePath(searchDir || ".", cwd);
	let isDirectory: boolean;
	try {
		isDirectory = (await stat(searchPath)).isDirectory();
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
		if (code === "ENOENT") {
			throw grepError("path_not_found", `Path not found: ${searchPath}`, "Check the search path and retry.", { path: searchPath });
		}
		throw grepError("path_unreadable", `Cannot access path: ${searchPath}`, "Check path permissions and retry.", {
			path: searchPath,
			...(code ? { cause: code } : {}),
		});
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
				maxCountPerFile: grepMode === "content" ? MAX_MATCHES_PER_FILE : undefined,
				contextBefore: contextValue,
				contextAfter: contextValue,
				maxColumns: GREP_MAX_LINE_LENGTH,
				mode: resolveNativeMode(grepMode),
				signal,
				timeoutMs: SEARCH_TIMEOUT_MS,
			},
		);
	} catch (err) {
		if (err instanceof Error && /^regex(?: parse)? error/i.test(err.message)) {
			const message = err.message.replace(/^regex(?: parse)? error:?\s*/i, "Invalid regex: ");
			throw grepError("invalid_regex", message, "Use literal=true for exact text or fix the regex syntax.", { pattern, literal: Boolean(literal) });
		}
		if (signal?.aborted) {
			throw grepError("search_aborted", "Search was cancelled", "Retry the search if it is still needed.", { path: searchPath });
		}
		if (err instanceof Error && /(?:aborted:\s*)?timeout/i.test(err.message)) {
			throw grepError(
				"search_timeout",
				`Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s; narrow paths or pattern`,
				"Reduce the search path, add a glob filter, or make the pattern more specific.",
				{ path: searchPath, pattern },
			);
		}
		throw err;
	}

	return buildGrepResponse(grepMode, result.matches, isDirectory, searchPath, contextValue, result, effectiveLimit);
}

export function registerGrepTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...builtInGrep,
		description:
			"Search file contents by regex or literal pattern. Use this when you need matching lines, counts, or files with matches. Respects .gitignore and truncates long lines in output.",
		promptSnippet: "Search file contents by regex or literal pattern",
		promptGuidelines: [
			"Use grep for regex or literal content searches; set path and glob to narrow the search when useful.",
			"Use context when the lines surrounding a match are relevant; leave it at 0 for concise results.",
			"Use mode=filesWithMatches for matching paths and mode=count for per-file match totals.",
			"Use literal=true for exact text containing regex metacharacters.",
			"Use read or other tools when you need full file context or additional processing.",
		],
		parameters: grepSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeGrepNative({
				...(params as GrepParams),
				cwd: ctx?.cwd ?? process.cwd(),
				signal,
			});
		},
	});
}

