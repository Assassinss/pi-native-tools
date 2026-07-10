import {
	createBashToolDefinition,
	type BashToolDetails,
	DEFAULT_MAX_BYTES,
	formatSize,
	truncateTail,
	type TruncationResult,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeShell, Shell, type ShellRunResult } from "./omp-native.ts";
import { randomBytes } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolError } from "./shared.ts";

function bashError(code: string, message: string, hint?: string, details?: Record<string, unknown>): Error {
	return toolError({ tool: "bash", code, message, hint, details, retryable: code !== "command_failed" });
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
const MODEL_MAX_BYTES = 16 * 1024;
const MODEL_MAX_LINES = 500;
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

function compactOutput(text: string): string {
	const lines = text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").split("\n");
	const compacted: string[] = [];
	for (let start = 0; start < lines.length;) {
		let end = start + 1;
		while (end < lines.length && lines[end] === lines[start]) end++;
		const line = lines[start];
		if (line || compacted.at(-1) !== "") compacted.push(end - start > 1 && line ? `${line} [repeated ${end - start} times]` : line);
		start = end;
	}
	return compacted.join("\n");
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
		if (!this.tempFileStream) return;
		const stream = this.tempFileStream;
		this.tempFileStream = undefined;
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				stream.off("finish", onFinish);
				reject(error);
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});
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
		this.tempFileStream = createWriteStream(this.tempFilePath);
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

function disposeShellSession(sessionKey: string): void {
	const shell = shellSessions.get(sessionKey);
	clearShellSessionEviction(sessionKey);
	shellSessions.delete(sessionKey);
	shellSessionsInitialized.delete(sessionKey);
	if (shell) void shell.abort().catch(() => undefined);
}

function scheduleShellSessionEviction(sessionKey: string): void {
	clearShellSessionEviction(sessionKey);
	const idleMs = getShellSessionIdleMs();
	if (idleMs <= 0 || !shellSessions.has(sessionKey)) return;
	const timer = setTimeout(() => {
		shellSessionEvictionTimers.delete(sessionKey);
		if (shellSessionsInUse.has(sessionKey)) return;
		disposeShellSession(sessionKey);
	}, idleMs);
	timer.unref?.();
	shellSessionEvictionTimers.set(sessionKey, timer);
}

export function getBashSessionCount(): number {
	return shellSessions.size;
}

export function clearBashSessions(): void {
	for (const sessionKey of shellSessions.keys()) disposeShellSession(sessionKey);
}

function formatOutput(snapshot: OutputSnapshot, emptyText = "(no output)"): { text: string; details?: BashToolDetails } {
	const truncation = snapshot.truncation;
	let text = compactOutput(snapshot.content) || emptyText;
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
	try {
		await access(cwd, constants.F_OK);
		return await realpath(cwd);
	} catch {
		throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
	}
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
	if (options?.resetSession) disposeShellSession(sessionKey);

	const useSession = options?.session !== false;
	const sessionBusy = useSession && shellSessionsInUse.has(sessionKey);
	let shell = useSession && !sessionBusy ? shellSessions.get(sessionKey) : undefined;
	if (!shell && useSession && !sessionBusy) {
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
			if (error) return;
			if (!chunk) return;
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
			accumulator.finish();
			const snapshot = accumulator.snapshot();
			await accumulator.closeTempFile();
			const { text } = formatOutput(snapshot, "");
			if (controller.signal.aborted) {
				throw bashError("aborted", appendStatus(text, "Command aborted"), "Retry the command if cancellation was unintended.", { cwd: resolvedCwd });
			}
			if (err instanceof Error) throw bashError("execution_failed", appendStatus(text, err.message), undefined, { cwd: resolvedCwd });
			throw err;
		}
		if (shell && !result.cancelled && !result.timedOut) shellSessionsInitialized.add(sessionKey);
		accumulator.finish();
		const snapshot = accumulator.snapshot();
		await accumulator.closeTempFile();
		const { text, details } = formatOutput(snapshot);
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
		if (controller.signal.aborted && shell) {
			disposeShellSession(sessionKey);
		} else if (shell) {
			scheduleShellSessionEviction(sessionKey);
		}
	}
}

export function registerBashTool(pi: ExtensionAPI): void {
	pi.registerTool({
		...builtInBash,
		description:
			"Execute shell commands in the current working directory. Use this for build, test, run, git, and other shell-specific tasks. Do not use it for routine file reading or code search when read, find, or grep can answer more directly. Output is truncated and full output is retrievable via the artifact system.",
		promptSnippet: "Run shell commands",
		promptGuidelines: [
			"Use bash only for shell-dependent work such as builds, tests, git, or environment inspection.",
			"Use read, find, grep, write, or edit for file operations and searches.",
			"Prefer commands with concise output; filter verbose success logs and preserve failure details.",
			"Set timeout for commands that may run for a long time.",
			"Sessions persist per cwd; use session=false for isolation or resetSession=true to discard state.",
		],
		parameters: bashSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { command, timeout, session, resetSession } = params as {
				command: string;
				timeout?: number;
				session?: boolean;
				resetSession?: boolean;
			};
			return executeBashNative(command, ctx?.cwd ?? process.cwd(), timeout, signal, onUpdate as any, { session, resetSession });
		},
	});
}

