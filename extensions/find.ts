import {
	createFindToolDefinition,
	type ExtensionAPI,
	type FindToolDetails,
	DEFAULT_MAX_BYTES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { FileType, glob } from "./omp-native.ts";
import path, { basename } from "node:path";
import { lstat } from "node:fs/promises";
import { normalizePath } from "./shared.ts";

const builtInFind = createFindToolDefinition(process.cwd());
const DEFAULT_LIMIT = 1000;

function isIgnoredDefaultPath(relativePath: string): boolean {
	return relativePath === ".git" || relativePath.startsWith(".git/") || relativePath === "node_modules" || relativePath.startsWith("node_modules/");
}

function formatMatchPath(relativePath: string, fileType: FileType): string {
	return fileType === FileType.Dir && !relativePath.endsWith("/") ? `${relativePath}/` : relativePath;
}

export async function executeFindNative(
	pattern: string,
	searchDir: string | undefined,
	limit: number | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: FindToolDetails }> {
	const searchPath = normalizePath(searchDir || ".", cwd);
	const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

	let searchStat;
	try {
		searchStat = await lstat(searchPath);
	} catch {
		throw new Error(`Path not found: ${searchPath}`);
	}

	if (searchStat.isFile()) {
		const name = basename(searchPath).replace(/\\/g, "/");
		const matches = path.matchesGlob(name, pattern) ? [name] : [];
		if (matches.length === 0) return { content: [{ type: "text", text: "No files found matching pattern" }] };
		return { content: [{ type: "text", text: matches[0] }], details: undefined };
	}
	if (!searchStat.isDirectory()) {
		throw new Error(`Path is not a directory: ${searchPath}`);
	}

	const result = await glob({
		pattern,
		path: searchPath,
		hidden: true,
		gitignore: true,
		cache: true,
		includeNodeModules: false,
		maxResults: effectiveLimit,
		sortByMtime: true,
		signal,
	});
	const relativePaths = result.matches
		.filter((match) => match.path && !isIgnoredDefaultPath(match.path))
		.map((match) => formatMatchPath(match.path, match.fileType));

	if (relativePaths.length === 0) {
		return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
	}

	const rawOutput = relativePaths.join("\n");
	const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
	let text = truncation.content;
	const details: FindToolDetails = {};
	const notices: string[] = [];
	if (result.totalMatches > relativePaths.length) {
		notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
		details.resultLimitReached = effectiveLimit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (notices.length > 0) text += `\n\n[${notices.join(". ")}]`;
	return { content: [{ type: "text", text }], details: Object.keys(details).length > 0 ? details : undefined };
}

export function registerFindTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...builtInFind,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { pattern, path: searchDir, limit } = params as { pattern: string; path?: string; limit?: number };
			return executeFindNative(pattern, searchDir, limit, ctx?.cwd ?? process.cwd(), signal);
		},
	});
}
