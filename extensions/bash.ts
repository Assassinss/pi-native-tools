import {
	createBashToolDefinition,
	type BashToolDetails,
	DEFAULT_MAX_BYTES,
	formatSize,
	truncateTail,
	type TruncationResult,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { executeShell, Shell, type ShellRunResult } from "./omp-native.ts";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolError } from "./shared.ts";

function bashError(code: string, message: string, hint?: string, details?: Record<string, unknown>): Error {
	return toolError({ tool: "bash", code, message, hint, details, retryable: code === "aborted" || code === "timeout" || code === "session_busy" });
}

type TextContent = { type: "text"; text: string };

type OutputSnapshot = {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
};

type BashOptions = {
	session?: boolean;
	resetSession?: boolean;
};

const builtInBash = createBashToolDefinition(process.cwd());
const bashSchema = Type.Object(
	{
		command: Type.String({ description: "The shell command to execute. Best for build, test, run, git, or other shell-specific tasks." }),
		timeout: Type.Optional(Type.Number({ minimum: 0, description: "Timeout in seconds for this command. Must be >= 0. Omit to use no explicit timeout." })),
		session: Type.Optional(Type.Boolean({ description: "When false, run in a fresh one-shot shell instead of the persistent per-cwd session." })),
		resetSession: Type.Optional(Type.Boolean({ description: "When true, discard the existing persistent shell session for this cwd before running the command." })),
	},
	{ additionalProperties: false },
);
type BashInput = Static<typeof bashSchema>;

// Keep shell output compact for the model; full output remains available when truncated.
const MODEL_MAX_BYTES = 8 * 1024;
const MODEL_MAX_LINES = 250;
const shellSessions = new Map<string, Shell>();
const shellSessionsInitialized = new Set<string>();
const shellSessionsInUse = new Set<string>();
const shellSessionEvictionTimers = new Map<string, ReturnType<typeof setTimeout>>();

function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

export type OutputPolicy = "result" | "diagnostic" | "progress" | "passthrough";

type SegmentPolicy = OutputPolicy | "neutral" | "forwarder";
type CommandInvocation = { name: string; args: string[] };

const RESULT_COMMANDS = new Set([
	"pwd",
	"whoami",
	"hostname",
	"date",
	"env",
	"printenv",
	"uname",
	"id",
	"ls",
	"dir",
	"tree",
	"rg",
	"ripgrep",
	"grep",
	"egrep",
	"fgrep",
	"find",
	"fd",
	"cat",
	"bat",
	"head",
	"tail",
	"less",
	"more",
	"sed",
	"awk",
	"cut",
	"sort",
	"uniq",
	"wc",
	"du",
	"df",
	"stat",
	"file",
	"realpath",
	"readlink",
	"which",
	"where",
	"whereis",
	"type",
	"jq",
	"yq",
]);

const NO_OUTPUT_COMMANDS = new Set([
	":",
	"cd",
	"pushd",
	"popd",
	"export",
	"unset",
	"umask",
	"ulimit",
	"readonly",
	"declare",
	"typeset",
	"local",
	"let",
	"alias",
	"unalias",
	"true",
	"false",
	"sleep",
	"wait",
	"mkdir",
	"rmdir",
	"rm",
	"del",
	"copy",
	"move",
	"cp",
	"mv",
	"touch",
	"chmod",
	"chown",
	"ln",
	"kill",
]);

const DIAGNOSTIC_COMMANDS = new Set([
	"pytest",
	"py.test",
	"vitest",
	"jest",
	"mocha",
	"_mocha",
	"ava",
	"tap",
	"tsc",
	"eslint",
	"eslint_d",
	"stylelint",
	"flake8",
	"pylint",
	"mypy",
	"pyright",
	"golangci-lint",
	"shellcheck",
	"hadolint",
	"markdownlint",
	"phpstan",
	"phpunit",
	"rspec",
	"rubocop",
]);

const PROGRESS_COMMANDS = new Set([
	"make",
	"gmake",
	"ninja",
	"msbuild",
	"xcodebuild",
	"webpack",
	"rollup",
	"esbuild",
	"parcel",
]);

const PACKAGE_MANAGER_NAMES = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_OPTION_VALUES = new Set([
	"-C",
	"--prefix",
	"--dir",
	"--cwd",
	"--filter",
	"-F",
	"--workspace",
	"-w",
	"--registry",
	"--cache",
	"--config",
	"--loglevel",
	"--tag",
	"--target",
	"--network-concurrency",
]);
const RUN_OPTION_VALUES = new Set(["--workspace", "-w", "--filter", "-F"]);
const LAUNCHER_OPTION_VALUES = new Set(["-p", "--package", "--prefix", "--cwd", "-C"]);

function executableName(token: string): string {
	const withoutGrouping = token.replace(/^[({]+/, "");
	const baseName = withoutGrouping.split(/[\\/]/).at(-1) ?? withoutGrouping;
	return baseName.replace(/\.(?:cmd|exe|bat)$/i, "").toLowerCase();
}

function isAssignment(token: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(token);
}

/** Split only on shell control operators outside quotes. It is deliberately not a shell parser. */
function splitShellCommands(command: string): string[][] {
	const segments: string[][] = [];
	let words: string[] = [];
	let word = "";
	let wordStarted = false;
	let quote: "'" | '"' | "`" | undefined;
	let escaped = false;
	let substitutionDepth = 0;
	let comment = false;

	const flushWord = () => {
		if (!wordStarted) return;
		words.push(word);
		word = "";
		wordStarted = false;
	};
	const flushSegment = () => {
		flushWord();
		if (words.length > 0) segments.push(words);
		words = [];
	};

	for (let index = 0; index < command.length; index++) {
		const character = command[index]!;
		if (comment) {
			if (character === "\n" || character === "\r") comment = false;
			if (!comment) flushSegment();
			continue;
		}
		if (quote) {
			if (quote === "'" && character === "'") quote = undefined;
			else if (quote !== "'" && character === "\\") {
				const next = command[index + 1];
				if (next !== undefined) {
					word += next;
					wordStarted = true;
					index++;
				} else word += character;
			} else if (character === quote) quote = undefined;
			else word += character;
			continue;
		}
		if (substitutionDepth > 0) {
			if (character === "$" && command[index + 1] === "(") {
				word += "$(";
				wordStarted = true;
				substitutionDepth++;
				index++;
			} else {
				word += character;
				wordStarted = true;
				if (character === ")") substitutionDepth--;
			}
			continue;
		}
		if (escaped) {
			word += character;
			wordStarted = true;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			wordStarted = true;
			continue;
		}
		if (character === "'" || character === '"' || character === "`") {
			quote = character;
			wordStarted = true;
			continue;
		}
		if (character === "$" && command[index + 1] === "(") {
			word += "$(";
			wordStarted = true;
			substitutionDepth = 1;
			index++;
			continue;
		}
		if (character === "#" && !wordStarted && words.length === 0) {
			comment = true;
			continue;
		}
		if (character === "\n" || character === "\r") {
			flushSegment();
			continue;
		}
		if (/\s/.test(character)) {
			flushWord();
			continue;
		}
		if (character === ";") {
			flushSegment();
			continue;
		}
		if (character === "&") {
			if (command[index + 1] === "&") {
				flushSegment();
				index++;
			} else if (command[index - 1] === ">" || command[index - 1] === "<" || command[index + 1] === ">") {
				word += character;
				wordStarted = true;
			} else flushSegment();
			continue;
		}
		if (character === "|") {
			flushSegment();
			if (command[index + 1] === "|" || command[index + 1] === "&") index++;
			continue;
		}
		word += character;
		wordStarted = true;
	}
	if (escaped) word += "\\";
	flushSegment();
	return segments;
}

function optionName(option: string): string {
	const equals = option.indexOf("=");
	return equals >= 0 ? option.slice(0, equals) : option;
}

function skipOptions(words: string[], start: number, optionsWithValues: ReadonlySet<string>): number {
	let index = start;
	while (index < words.length) {
		const word = words[index]!;
		if (word === "--") return index + 1;
		if (!word.startsWith("-") || word === "-") break;
		index++;
		if (word.indexOf("=") < 0 && optionsWithValues.has(optionName(word))) index++;
	}
	return index;
}

function removeGroupingPrefix(words: string[]): string[] {
	const result = [...words];
	while (result.length > 0) {
		const original = result[0]!;
		const stripped = original.replace(/^[({]+/, "");
		if (stripped === original) break;
		if (stripped) result[0] = stripped;
		else result.shift();
	}
	return result;
}

function wrapperCommandIndex(name: string, words: string[], start: number): number | undefined {
	if (name === "command" && ["-v", "-V", "-p"].includes(words[start]?.toLowerCase() ?? "")) return undefined;
	if (name === "env") return skipOptions(words, start, new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]));
	if (name === "sudo") return skipOptions(words, start, new Set(["-u", "--user", "-g", "--group", "-C", "--chdir", "-D", "--chdir"]));
	if (name === "command" || name === "exec") return skipOptions(words, start, new Set(["-a"]));
	if (name === "time") return skipOptions(words, start, new Set(["-f", "--format", "-o", "--output"]));
	if (name === "nice") return skipOptions(words, start, new Set(["-n", "--adjustment"]));
	if (name === "nohup" || name === "setsid") return skipOptions(words, start, new Set());
	if (name === "stdbuf") return skipOptions(words, start, new Set(["-i", "-o", "-e"]));
	if (name === "timeout") {
		const index = skipOptions(words, start, new Set(["-k", "--kill-after", "-s", "--signal"]));
		return /^\d+(?:\.\d+)?(?:ms|s|m|h|d|w)?$/i.test(words[index] ?? "") ? index + 1 : index;
	}
	if (name === "cross-env" || name === "cross-env-shell") {
		let index = skipOptions(words, start, new Set());
		while (isAssignment(words[index] ?? "")) index++;
		return index;
	}
	return undefined;
}

function unwrapInvocation(input: string[]): CommandInvocation | undefined {
	let words = removeGroupingPrefix(input);
	for (let depth = 0; depth < 8; depth++) {
		while (isAssignment(words[0] ?? "")) words = words.slice(1);
		if (words.length === 0) return undefined;
		const name = executableName(words[0]!);
		if (name === ")" || name === "}") return undefined;
		const next = wrapperCommandIndex(name, words, 1);
		if (next === undefined || next >= words.length) return { name, args: words.slice(1) };
		words = removeGroupingPrefix(words.slice(next));
	}
	return undefined;
}

function firstCommandIndex(args: string[], optionsWithValues = PACKAGE_OPTION_VALUES): number {
	return skipOptions(args, 0, optionsWithValues);
}

function scriptParts(script: string): string[] {
	return script.replace(/[)}]+$/, "").toLowerCase().split(/[:._-]+/).filter(Boolean);
}

function classifyScript(script: string): SegmentPolicy {
	const parts = scriptParts(script);
	if (parts.length === 0) return "result";
	if (parts.some((part) => ["test", "tests", "lint", "typecheck", "check", "validate", "verify", "audit", "coverage", "unittest"].includes(part))) {
		return "diagnostic";
	}
	if (parts.some((part) => ["build", "bundle", "compile", "package", "release", "deploy", "generate", "codegen", "dev", "start", "serve", "watch"].includes(part))) {
		return "progress";
	}
	return "passthrough";
}

function classifyPackageManager(name: string, args: string[], depth: number): SegmentPolicy {
	if (args.length === 0 || args.some((arg) => ["--version", "-v", "--help", "-h"].includes(arg.toLowerCase()))) return "result";
	let index = firstCommandIndex(args);
	if (index >= args.length) return "result";
	let subcommand = args[index]!.replace(/[)}]+$/, "").toLowerCase();
	if (name === "yarn" && subcommand === "workspace") {
		index += 2;
		if (index >= args.length) return "passthrough";
		subcommand = args[index]!.toLowerCase();
	}
	if (subcommand === "run" || subcommand === "run-script") {
		const scriptIndex = skipOptions(args, index + 1, RUN_OPTION_VALUES);
		return scriptIndex < args.length ? classifyScript(args[scriptIndex]!) : "result";
	}
	if (subcommand === "exec" || subcommand === "dlx" || subcommand === "x") {
		const toolIndex = skipOptions(args, index + 1, LAUNCHER_OPTION_VALUES);
		return toolIndex < args.length ? classifySegment(args.slice(toolIndex), depth + 1) : "passthrough";
	}
	if (subcommand === "pm" && index + 1 < args.length) {
		const pmCommand = args[index + 1]!.toLowerCase();
		if (["ls", "list", "bin", "cache", "view"].includes(pmCommand)) return "result";
	}
	if (["test", "t", "tst", "lint", "typecheck", "check", "validate", "verify", "audit", "outdated", "doctor"].includes(subcommand)) {
		return "diagnostic";
	}
	if (["list", "ls", "root", "prefix", "view", "info", "why", "config", "help", "search", "whoami"].includes(subcommand)) return "result";
	if (["install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "build", "rebuild", "compile", "pack", "publish", "prune", "dedupe", "fetch", "deploy", "start", "serve"].includes(subcommand)) {
		return "progress";
	}
	return classifyScript(subcommand);
}

function classifyGit(args: string[]): SegmentPolicy {
	if (args.some((arg) => ["--version", "-v", "--help", "-h"].includes(arg.toLowerCase()))) return "result";
	const index = firstCommandIndex(args, new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "-c", "--config-env"]));
	if (index >= args.length) return "result";
	const subcommand = args[index]!.toLowerCase();
	const rest = args.slice(index + 1);
	if (subcommand === "diff" && rest.includes("--check")) return "diagnostic";
	if (["status", "log", "diff", "show", "branch", "rev-parse", "describe", "shortlog", "tag", "remote", "ls-files", "ls-tree", "cat-file", "grep", "blame", "check-ignore", "check-attr"].includes(subcommand)) return "result";
	if (["fsck", "verify-commit", "verify-tag"].includes(subcommand)) return "diagnostic";
	if (["clone", "fetch", "pull", "push", "gc", "repack", "add", "commit", "merge", "rebase", "cherry-pick", "checkout", "switch", "reset", "clean", "stash"].includes(subcommand)) return "progress";
	return "passthrough";
}

function classifyCargo(args: string[]): SegmentPolicy {
	const index = firstCommandIndex(args, new Set(["--manifest-path", "--target", "--package", "-p", "--features", "--profile", "-j", "--jobs"]));
	const subcommand = args[index]?.toLowerCase();
	if (!subcommand) return "result";
	if (["test", "check", "clippy", "bench"].includes(subcommand)) return "diagnostic";
	if (subcommand === "fmt") return args.includes("--check") ? "diagnostic" : "passthrough";
	if (["metadata", "tree", "search", "version", "--version", "--help", "-h", "-V"].includes(subcommand)) return "result";
	if (["build", "doc", "install", "publish", "package", "update", "vendor", "clean"].includes(subcommand)) return "progress";
	return "passthrough";
}

function classifyGo(args: string[]): SegmentPolicy {
	const index = firstCommandIndex(args, new Set(["-C", "-mod", "-modfile", "-overlay", "-tags", "-toolexec"]));
	const subcommand = args[index]?.toLowerCase();
	if (!subcommand) return "result";
	if (["test", "vet"].includes(subcommand)) return "diagnostic";
	if (["env", "version", "list", "doc", "help", "--version", "--help", "-h"].includes(subcommand)) return "result";
	if (["build", "install", "generate", "clean", "download"].includes(subcommand)) return "progress";
	return "passthrough";
}

function classifyDocker(args: string[], name: string): SegmentPolicy {
	const composeOptions = new Set(["--project-name", "-p", "--file", "-f", "--profile"]);
	if (name === "docker-compose") {
		const composeIndex = firstCommandIndex(args, composeOptions);
		const composeCommand = args[composeIndex]?.toLowerCase();
		if (["build", "pull", "push", "up"].includes(composeCommand ?? "")) return "progress";
		if (["ps", "images", "logs", "config", "inspect"].includes(composeCommand ?? "")) return "result";
		return "passthrough";
	}
	const index = firstCommandIndex(args, new Set(["-H", "--host", "--config", "-l", "--log-level", "--context"]));
	const subcommand = args[index]?.toLowerCase();
	if (!subcommand) return "result";
	if (subcommand === "compose" || subcommand === "docker-compose") {
		const composeIndex = firstCommandIndex(args.slice(index + 1), new Set(["--project-name", "-p", "--file", "-f", "--profile"]));
		const composeCommand = args[index + 1 + composeIndex]?.toLowerCase();
		if (["build", "pull", "push", "up"].includes(composeCommand ?? "")) return "progress";
		if (["ps", "images", "logs", "config", "inspect"].includes(composeCommand ?? "")) return "result";
		return "passthrough";
	}
	if (subcommand === "buildx") {
		const buildxCommand = args[index + 1]?.toLowerCase();
		return buildxCommand === "build" ? "progress" : buildxCommand === "ls" || buildxCommand === "inspect" ? "result" : "passthrough";
	}
	if (subcommand === "system") {
		const systemCommand = args[index + 1]?.toLowerCase();
		return systemCommand === "df" || systemCommand === "info" ? "result" : systemCommand === "prune" ? "progress" : "passthrough";
	}
	if (["ps", "images", "inspect", "logs", "version", "info", "history", "port", "top"].includes(subcommand)) return "result";
	if (["build", "pull", "push"].includes(subcommand)) return "progress";
	return "passthrough";
}

function classifyInterpreter(name: string, args: string[], depth: number): SegmentPolicy | undefined {
	if (/^python(?:3(?:\.\d+)?)?$/.test(name) || name === "python3") {
		const moduleIndex = args.indexOf("-m");
		if (moduleIndex >= 0 && args[moduleIndex + 1]) {
			const module = executableName(args[moduleIndex + 1]!);
			if (["pytest", "unittest", "nose", "mypy", "pyright"].includes(module)) return "diagnostic";
			if (module === "pip" || module === "pip3") return classifyPip(args.slice(moduleIndex + 2));
		}
		return undefined;
	}
	if (name === "node" || name === "nodejs") return args.includes("--test") ? "diagnostic" : undefined;
	if (name === "deno") {
		const subcommand = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
		return ["test", "lint", "check"].includes(subcommand ?? "") ? "diagnostic" : ["compile"].includes(subcommand ?? "") ? "progress" : undefined;
	}
	if (name === "ruby") {
		const switchIndex = args.indexOf("-S");
		if (switchIndex >= 0 && args[switchIndex + 1]) return classifySegment(args.slice(switchIndex + 1), depth + 1);
	}
	return undefined;
}

function classifyPip(args: string[]): SegmentPolicy {
	if (args.some((arg) => ["--version", "-V", "-v", "--help", "-h"].includes(arg.toLowerCase()))) return "result";
	const subcommand = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
	if (["install", "download", "wheel", "sync"].includes(subcommand ?? "")) return "progress";
	if (["check"].includes(subcommand ?? "")) return "diagnostic";
	if (["list", "show", "freeze", "index"].includes(subcommand ?? "")) return "result";
	return "passthrough";
}

function classifyBuildTool(name: string, args: string[]): SegmentPolicy | undefined {
	const task = args.filter((arg) => !arg.startsWith("-")).map((arg) => scriptParts(arg));
	const hasDiagnosticTask = task.some((parts) => parts.some((part) => ["test", "check", "lint", "verify"].includes(part)));
	if (["make", "gmake", "ninja"].includes(name)) return hasDiagnosticTask ? "diagnostic" : "progress";
	if (name === "cmake") return args.includes("--build") ? (hasDiagnosticTask ? "diagnostic" : "progress") : undefined;
	if (["gradle", "gradlew", "mvn", "mvnw"].includes(name)) return hasDiagnosticTask ? "diagnostic" : "progress";
	if (PROGRESS_COMMANDS.has(name)) return hasDiagnosticTask ? "diagnostic" : "progress";
	if (name === "vite" || name === "next") return ["build", "dev", "start", "serve", "export"].includes(args.find((arg) => !arg.startsWith("-"))?.toLowerCase() ?? "") ? "progress" : undefined;
	if (["turbo", "nx", "lerna", "bazel"].includes(name)) return hasDiagnosticTask ? "diagnostic" : task.length > 0 ? "progress" : undefined;
	return undefined;
}

function classifySegment(words: string[], depth: number): SegmentPolicy {
	const invocation = unwrapInvocation(words);
	if (!invocation) return "neutral";
	const { name, args } = invocation;
	if (NO_OUTPUT_COMMANDS.has(name)) return "neutral";
	if (name === "set") return args.length === 0 ? "result" : "neutral";
	if (name === "command" && ["-v", "-V", "-p"].includes(args[0]?.toLowerCase() ?? "")) return "result";
	if (name === "echo" || name === "printf" || name === "tee") return name === "tee" ? "forwarder" : "passthrough";
	if ((name === "sh" || name === "bash" || name === "dash" || name === "zsh" || name === "ksh" || name === "fish") && depth < 4) {
		const commandIndex = args.findIndex((arg) => arg === "-c" || /^-[^-]*c$/.test(arg));
		return commandIndex >= 0 && args[commandIndex + 1] ? classifyCommandInternal(args[commandIndex + 1]!, depth + 1) : "passthrough";
	}
	if (PACKAGE_MANAGER_NAMES.has(name)) return classifyPackageManager(name, args, depth);
	if (name === "npx" || name === "bunx") {
		if (args.some((arg) => ["--version", "-v", "--help", "-h"].includes(arg.toLowerCase()))) return "result";
		const toolIndex = skipOptions(args, 0, LAUNCHER_OPTION_VALUES);
		return toolIndex < args.length ? classifySegment(args.slice(toolIndex), depth + 1) : "passthrough";
	}
	if (name === "git") return classifyGit(args);
	if (name === "cargo") return classifyCargo(args);
	if (name === "go") return classifyGo(args);
	if (name === "docker" || name === "docker-compose") return classifyDocker(args, name);
	if (name === "pip" || name === "pip3") return classifyPip(args);
	const interpreterPolicy = classifyInterpreter(name, args, depth);
	if (interpreterPolicy) return interpreterPolicy;
	if (args.some((arg) => ["--help", "-h", "--version", "-V"].includes(arg.toLowerCase()))) return "result";
	if (name === "biome") {
		const subcommand = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
		return ["check", "lint", "ci"].includes(subcommand ?? "") || (subcommand === "format" && args.includes("--check")) ? "diagnostic" : "passthrough";
	}
	if (name === "prettier") return args.includes("--check") || args.includes("--list-different") ? "diagnostic" : "passthrough";
	if (name === "ruff") return args.includes("--check") || args.includes("check") ? "diagnostic" : "passthrough";
	if (DIAGNOSTIC_COMMANDS.has(name)) return "diagnostic";
	const buildPolicy = classifyBuildTool(name, args);
	if (buildPolicy) return buildPolicy;
	if (RESULT_COMMANDS.has(name)) return "result";
	return "passthrough";
}

function classifyCommandInternal(command: string, depth: number): OutputPolicy {
	if (depth > 4) return "passthrough";
	const policies = splitShellCommands(command).map((words) => classifySegment(words, depth));
	if (policies.length === 0 || policies.includes("passthrough")) return "passthrough";
	if (policies.includes("forwarder")) return "passthrough";
	const activePolicies = policies.filter((policy): policy is OutputPolicy => policy !== "neutral");
	if (activePolicies.length === 0) return "result";
	const uniquePolicies = new Set(activePolicies);
	// A result command mixed with a summarizable command would lose useful data.
	if (uniquePolicies.size > 1 && uniquePolicies.has("result")) return "passthrough";
	if (uniquePolicies.has("diagnostic")) return "diagnostic";
	if (uniquePolicies.has("progress")) return "progress";
	return "result";
}

export function classifyCommand(command: string): OutputPolicy {
	return classifyCommandInternal(command, 0);
}

function compactOutput(text: string): string {
	const ansiStripped = text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
	const lines: string[] = [];
	for (const rawLine of ansiStripped.split("\n")) {
		// Progress indicators commonly redraw the same line with carriage returns.
		const refreshed = rawLine.split("\r").filter(Boolean).at(-1) ?? "";
		if (refreshed.trim() || lines.at(-1)?.trim()) lines.push(refreshed);
	}

	const compacted: string[] = [];
	for (let start = 0; start < lines.length;) {
		let end = start + 1;
		while (end < lines.length && lines[end] === lines[start]) end++;
		const line = lines[start]!;
		compacted.push(end - start > 1 && line ? `${line} [repeated ${end - start} times]` : line);
		start = end;
	}
	return compacted.join("\n");
}

function summarizeDiagnosticOutput(text: string, policy: OutputPolicy, successful: boolean): string {
	const lines = text.split("\n").filter((line) => line.trim());
	if (policy === "passthrough" || policy === "result") return text;
	const important = lines.filter((line) => /\b(?:error|warning|warn|failed|failure|exception|panic|fatal|passed)\b|(?::\d+(?::\d+)?\s*[-—:]?)/i.test(line));
	if (!successful) return [...new Set([...important, ...lines.slice(-8)])].join("\n");
	if (policy === "diagnostic") return important.length > 0 ? [...new Set(important)].join("\n") : "Command completed successfully.";
	return important.length > 0 ? [...new Set([...important, ...lines.slice(-3)])].join("\n") : lines.slice(-3).join("\n");
}

class OutputAccumulator {
	private readonly maxLines = MODEL_MAX_LINES;
	private readonly maxBytes = MODEL_MAX_BYTES;
	private readonly maxRollingBytes = Math.max(DEFAULT_MAX_BYTES * 2, 1);
	private readonly tempFilePrefix = "pi-bash-native";
	private readonly rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;
	private tempFilePath?: string;
	private tempFileStream?: ReturnType<typeof createWriteStream>;
	private tempFileError?: Error;

	append(text: string): void {
		if (this.finished) throw new Error("Cannot append to a finished output accumulator");
		const data = Buffer.from(text, "utf-8");
		this.totalRawBytes += data.length;
		this.appendDecodedText(text);
		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.tempFileStream?.write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(): void {
		if (this.finished) return;
		this.finished = true;
		if (this.shouldUseTempFile()) this.ensureTempFile();
	}

	snapshot(): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};
		if (truncation.truncated) this.ensureTempFile();
		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.tempFilePath,
		};
	}

	async closeTempFile(): Promise<void> {
		if (!this.tempFileStream) {
			if (this.tempFileError) throw this.tempFileError;
			return;
		}
		const stream = this.tempFileStream;
		this.tempFileStream = undefined;
		if (this.tempFileError || stream.destroyed) {
			stream.destroy();
			throw this.tempFileError ?? new Error(`Failed to write full command output to ${this.tempFilePath}`);
		}
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				stream.off("error", onError);
				stream.off("finish", onFinish);
			};
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};
			const onFinish = () => {
				cleanup();
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});
		if (this.tempFileError) throw this.tempFileError;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) return;
		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail();

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}
		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) return this.tailText;
		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines;
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) return;
		this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
		this.tempFileStream = createWriteStream(this.tempFilePath, { mode: 0o600 });
		this.tempFileStream.on("error", (error) => {
			this.tempFileError ??= error;
		});
		for (const chunk of this.rawChunks) this.tempFileStream.write(chunk);
		this.rawChunks.length = 0;
	}
}

function appendStatus(text: string, status: string): string {
	return text ? `${text}\n\n${status}` : status;
}

function getShellSessionIdleMs(): number {
	const value = Number(process.env.PI_NATIVE_BASH_SESSION_IDLE_MS ?? 5 * 60_000);
	return Number.isFinite(value) && value >= 0 ? value : 5 * 60_000;
}

function getUpdateThrottleMs(): number {
	const value = Number(process.env.PI_NATIVE_BASH_UPDATE_THROTTLE_MS ?? 75);
	return Number.isFinite(value) && value >= 0 ? value : 75;
}

function clearShellSessionEviction(sessionKey: string): void {
	const timer = shellSessionEvictionTimers.get(sessionKey);
	if (!timer) return;
	shellSessionEvictionTimers.delete(sessionKey);
	clearTimeout(timer);
}

async function disposeShellSession(sessionKey: string): Promise<void> {
	const shell = shellSessions.get(sessionKey);
	clearShellSessionEviction(sessionKey);
	shellSessions.delete(sessionKey);
	shellSessionsInitialized.delete(sessionKey);
	shellSessionsInUse.delete(sessionKey);
	if (shell) await shell.abort().catch(() => undefined);
}

function scheduleShellSessionEviction(sessionKey: string): void {
	clearShellSessionEviction(sessionKey);
	const idleMs = getShellSessionIdleMs();
	if (idleMs <= 0 || !shellSessions.has(sessionKey)) return;
	const timer = setTimeout(() => {
		shellSessionEvictionTimers.delete(sessionKey);
		if (shellSessionsInUse.has(sessionKey)) return;
		void disposeShellSession(sessionKey);
	}, idleMs);
	timer.unref?.();
	shellSessionEvictionTimers.set(sessionKey, timer);
}

export function getBashSessionCount(): number {
	return shellSessions.size;
}

export async function clearBashSessions(): Promise<void> {
	await Promise.all([...shellSessions.keys()].map(disposeShellSession));
}

function formatOutput(snapshot: OutputSnapshot, command: string, successful: boolean, emptyText = "(no output)"): { text: string; details?: BashToolDetails } {
	const truncation = snapshot.truncation;
	const compacted = compactOutput(snapshot.content);
	let text = summarizeDiagnosticOutput(compacted, classifyCommand(command), successful) || emptyText;
	let details: BashToolDetails | undefined;
	if (truncation.truncated) {
		details = { truncation, fullOutputPath: snapshot.fullOutputPath };
		const startLine = truncation.totalLines - truncation.outputLines + 1;
		const endLine = truncation.totalLines;
		if (truncation.lastLinePartial) {
			text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine}. Full output: ${snapshot.fullOutputPath}]`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
		} else {
			text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(MODEL_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
		}
	}
	return { text, details };
}

async function resolveShellCwd(cwd: string): Promise<string> {
	let resolvedCwd: string;
	try {
		resolvedCwd = await realpath(cwd);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw bashError("invalid_cwd", `Cannot access working directory: ${cwd}`, undefined, { cwd, reason });
	}
	if (!(await stat(resolvedCwd)).isDirectory()) {
		throw bashError("invalid_cwd", `Working directory is not a directory: ${cwd}`, undefined, { cwd: resolvedCwd });
	}
	return resolvedCwd;
}

function buildSessionKey(cwd: string): string {
	return cwd;
}

export async function executeBashNative(
	command: string,
	cwd: string,
	timeout: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate?: (update: { content: TextContent[]; details?: BashToolDetails }) => void,
	options?: BashOptions,
): Promise<{ content: TextContent[]; details?: BashToolDetails }> {
	const resolvedCwd = await resolveShellCwd(cwd);
	const sessionKey = buildSessionKey(resolvedCwd);
	const useSession = options?.session !== false;
	if ((useSession || options?.resetSession) && shellSessionsInUse.has(sessionKey)) {
		throw bashError(
			"session_busy",
			`The persistent shell session is already running a command for ${resolvedCwd}`,
			"Wait for it to finish, or retry with session=false for an isolated shell.",
			{ cwd: resolvedCwd },
		);
	}
	if (options?.resetSession) await disposeShellSession(sessionKey);

	let shell = useSession ? shellSessions.get(sessionKey) : undefined;
	if (!shell && useSession) {
		shell = new Shell();
		shellSessions.set(sessionKey, shell);
	}
	if (shell) clearShellSessionEviction(sessionKey);

	const accumulator = new OutputAccumulator();
	const controller = new AbortController();
	const relayAbort = () => {
		controller.abort();
		if (shell) void shell.abort().catch(() => undefined);
	};
	if (signal?.aborted) relayAbort();
	else signal?.addEventListener("abort", relayAbort, { once: true });

	let lastUpdateAt = 0;
	let pendingUpdateTimer: ReturnType<typeof setTimeout> | undefined;
	let acceptingOutput = true;
	let sessionReusable = true;
	const flushUpdate = () => {
		pendingUpdateTimer = undefined;
		if (!onUpdate) return;
		lastUpdateAt = Date.now();
		const snapshot = accumulator.snapshot();
		onUpdate({
			content: [{ type: "text", text: snapshot.content || "" }],
			details: snapshot.truncation.truncated ? { truncation: snapshot.truncation, fullOutputPath: snapshot.fullOutputPath } : undefined,
		});
	};
	const emitUpdate = () => {
		if (!onUpdate) return;
		const throttleMs = getUpdateThrottleMs();
		if (throttleMs <= 0) {
			flushUpdate();
			return;
		}
		const delay = throttleMs - (Date.now() - lastUpdateAt);
		if (delay <= 0) {
			flushUpdate();
			return;
		}
		if (pendingUpdateTimer) return;
		pendingUpdateTimer = setTimeout(flushUpdate, delay);
		pendingUpdateTimer.unref?.();
	};

	try {
		onUpdate?.({ content: [], details: undefined });
		if (shell) shellSessionsInUse.add(sessionKey);
		const callback = (error: Error | null, chunk: string | null) => {
			if (!acceptingOutput || error || !chunk) return;
			accumulator.append(chunk);
			emitUpdate();
		};
		const persistentRunOptions = {
			command,
			cwd: shellSessionsInitialized.has(sessionKey) ? undefined : resolvedCwd,
			timeoutMs: timeout ? timeout * 1000 : undefined,
			signal: controller.signal,
		};
		const runPromise: Promise<ShellRunResult> = shell
			? shell.run(persistentRunOptions, callback)
			: executeShell({ command, cwd: resolvedCwd, timeoutMs: timeout ? timeout * 1000 : undefined, signal: controller.signal }, callback);
		let result: ShellRunResult;
		try {
			result = await runPromise;
		} catch (err) {
			sessionReusable = false;
			acceptingOutput = false;
			accumulator.finish();
			const snapshot = accumulator.snapshot();
			await accumulator.closeTempFile();
			const { text } = formatOutput(snapshot, command, false, "");
			if (controller.signal.aborted) {
				throw bashError("aborted", appendStatus(text, "Command aborted"), "Retry the command if cancellation was unintended.", { cwd: resolvedCwd });
			}
			if (err instanceof Error) throw bashError("execution_failed", appendStatus(text, err.message), undefined, { cwd: resolvedCwd });
			throw err;
		}
		if (result.cancelled || result.timedOut) sessionReusable = false;
		if (shell && sessionReusable) shellSessionsInitialized.add(sessionKey);
		acceptingOutput = false;
		accumulator.finish();
		const snapshot = accumulator.snapshot();
		await accumulator.closeTempFile();
		const { text, details } = formatOutput(snapshot, command, (result.exitCode ?? 0) === 0 && !result.cancelled && !result.timedOut);
		if (result.cancelled || controller.signal.aborted) {
			throw bashError("aborted", appendStatus(text, "Command aborted"), "Retry the command if cancellation was unintended.", { cwd: resolvedCwd });
		}
		if (result.timedOut) {
			throw bashError(
				"timeout",
				appendStatus(text, `Command timed out after ${timeout} seconds`),
				"Increase timeout or make the command faster before retrying.",
				{ cwd: resolvedCwd, timeout },
			);
		}
		if ((result.exitCode ?? 0) !== 0) {
			throw bashError(
				"command_failed",
				appendStatus(text, `Command exited with code ${result.exitCode}`),
				"Inspect the command output and exit code, then fix the failing command or environment.",
				{ cwd: resolvedCwd, exitCode: result.exitCode ?? 0 },
			);
		}
		return { content: [{ type: "text", text }], details };
	} finally {
		signal?.removeEventListener("abort", relayAbort);
		if (pendingUpdateTimer) clearTimeout(pendingUpdateTimer);
		if (shell) shellSessionsInUse.delete(sessionKey);
		if (shell && (!sessionReusable || controller.signal.aborted)) {
			await disposeShellSession(sessionKey);
		} else if (shell) {
			scheduleShellSessionEviction(sessionKey);
		}
	}
}

export function registerBashTool(pi: ExtensionAPI): void {
	pi.on("session_shutdown", async () => {
		await clearBashSessions();
	});

	pi.registerTool({
		...builtInBash,
		description:
			"Execute shell commands and scripts in the current working directory. Use this for file operations, code search, build, test, run, git, and other shell tasks. Output is truncated and full output is retrievable via the artifact system.",
		promptSnippet: "Run shell commands",
		promptGuidelines: [
			"Use bash whenever shell commands or scripts are the most direct way to complete the task, including file operations, code search, builds, tests, runs, git operations, and environment inspection.",
			"Prefer focused commands and concise output when practical, while preserving warnings and failure details.",
			"Set an appropriate timeout for commands that may block or run for a long time.",
			"Choose session=true when commands need to share shell state; use session=false for isolated commands.",
			"Do not run parallel commands that share the same persistent session; use session=false for concurrent commands.",
		],
		parameters: bashSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { command, timeout, session, resetSession } = params as BashInput;
			return executeBashNative(command, ctx?.cwd ?? process.cwd(), timeout, signal, onUpdate as any, { session, resetSession });
		},
	});
}

