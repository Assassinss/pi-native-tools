import { createRequire } from "node:module";

export const FileType = {
	File: 1,
	Dir: 2,
	Symlink: 3,
} as const;

export type FileType = (typeof FileType)[keyof typeof FileType];

export interface GlobMatch {
	path: string;
	fileType: FileType;
	mtime?: number;
	size?: number;
}

export interface GlobOptions {
	pattern: string;
	path: string;
	fileType?: FileType;
	recursive?: boolean;
	hidden?: boolean;
	maxResults?: number;
	gitignore?: boolean;
	cache?: boolean;
	sortByMtime?: boolean;
	includeNodeModules?: boolean;
	signal?: unknown;
	timeoutMs?: number;
}

export interface GlobResult {
	matches: GlobMatch[];
	totalMatches: number;
}

export interface ContextLine {
	lineNumber: number;
	line: string;
}

export interface GrepMatch {
	path: string;
	lineNumber: number;
	line: string;
	contextBefore?: ContextLine[];
	contextAfter?: ContextLine[];
	truncated?: boolean;
	matchCount?: number;
}

export const GrepOutputMode = {
	Content: "content",
	Count: "count",
	FilesWithMatches: "filesWithMatches",
} as const;

export type GrepOutputMode = (typeof GrepOutputMode)[keyof typeof GrepOutputMode];

export interface GrepOptions {
	pattern: string;
	path: string;
	glob?: string;
	type?: string;
	ignoreCase?: boolean;
	multiline?: boolean;
	hidden?: boolean;
	gitignore?: boolean;
	maxCount?: number;
	offset?: number;
	contextBefore?: number;
	contextAfter?: number;
	context?: number;
	maxColumns?: number;
	mode?: GrepOutputMode;
	maxCountPerFile?: number;
	signal?: unknown;
	timeoutMs?: number;
}

export interface GrepResult {
	matches: GrepMatch[];
	totalMatches: number;
	filesWithMatches: number;
	filesSearched: number;
	limitReached?: boolean;
	skippedOversized?: number;
}

export interface ShellExecuteOptions {
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	sessionEnv?: Record<string, string>;
	timeoutMs?: number;
	snapshotPath?: string;
	minimizer?: unknown;
	signal?: unknown;
}

export interface ShellOptions {
	sessionEnv?: Record<string, string>;
	snapshotPath?: string;
	minimizer?: unknown;
}

export interface ShellRunOptions {
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	signal?: unknown;
}

export interface ShellRunResult {
	exitCode?: number;
	cancelled: boolean;
	timedOut: boolean;
	minimized?: unknown;
}

export interface Shell {
	run(
		options: ShellRunOptions,
		onChunk?: ((error: Error | null, chunk: string | null) => void) | null,
	): Promise<ShellRunResult>;
	abort(): Promise<void>;
}

const require = createRequire(import.meta.url);

function resolveNativePackage(): string {
	const key = `${process.platform}-${process.arch}`;
	switch (key) {
		case "win32-x64":
			return "@oh-my-pi/pi-natives-win32-x64";
		case "linux-x64":
			return "@oh-my-pi/pi-natives-linux-x64";
		case "linux-arm64":
			return "@oh-my-pi/pi-natives-linux-arm64";
		case "darwin-x64":
			return "@oh-my-pi/pi-natives-darwin-x64";
		case "darwin-arm64":
			return "@oh-my-pi/pi-natives-darwin-arm64";
		default:
			throw new Error(`Unsupported platform for native Pi tools: ${key}`);
	}
}

function loadNativeModule() {
	const packageName = resolveNativePackage();
	try {
		return require(packageName) as {
			__ompInstallTokioRuntime?: () => void;
			Shell: new (options?: ShellOptions | null) => Shell;
			executeShell: (
				options: ShellExecuteOptions,
				onChunk?: ((error: Error | null, chunk: string | null) => void) | null,
			) => Promise<ShellRunResult>;
			glob: (
				options: GlobOptions,
				onMatch?: ((error: Error | null, match: GlobMatch | null) => void) | null,
			) => Promise<GlobResult>;
			grep: (
				options: GrepOptions,
				onMatch?: ((error: Error | null, match: GrepMatch | null) => void) | null,
			) => Promise<GrepResult>;
			invalidateFsScanCache?: (path?: string | null) => void;
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Missing native runtime package ${packageName}. Reinstall this Pi package so npm installs its optional platform dependency. Original error: ${message}`,
		);
	}
}

const native = loadNativeModule();

native.__ompInstallTokioRuntime?.();

export const Shell = native.Shell;
export const executeShell = native.executeShell;
export const glob = native.glob;
export const grep = native.grep;
export const invalidateFsScanCache = native.invalidateFsScanCache;
