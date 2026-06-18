import {
	createBashToolDefinition,
	type BashToolDetails,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type TruncationResult,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { executeShell, Shell, type ShellRunResult } from "./omp-native.ts";
import { randomBytes } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type TextContent = { type: "text"; text: string };

type OutputSnapshot = {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
};

const builtInBash = createBashToolDefinition(process.cwd());
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

class OutputAccumulator {
	private readonly maxLines = DEFAULT_MAX_LINES;
	private readonly maxBytes = DEFAULT_MAX_BYTES;
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

	getLastLineBytes(): number {
		return this.currentLineBytes;
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
	let text = snapshot.content || emptyText;
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
			text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
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
): Promise<{ content: TextContent[]; details?: BashToolDetails }> {
	const resolvedCwd = await resolveShellCwd(cwd);
	const sessionKey = buildSessionKey(resolvedCwd);
	const sessionBusy = shellSessionsInUse.has(sessionKey);
	let shell = sessionBusy ? undefined : shellSessions.get(sessionKey);
	if (!shell && !sessionBusy) {
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
			if (controller.signal.aborted) throw new Error(appendStatus(text, "Command aborted"));
			if (err instanceof Error) throw new Error(appendStatus(text, err.message));
			throw err;
		}
		if (shell && !result.cancelled && !result.timedOut) shellSessionsInitialized.add(sessionKey);
		accumulator.finish();
		const snapshot = accumulator.snapshot();
		await accumulator.closeTempFile();
		const { text, details } = formatOutput(snapshot);
		if (result.cancelled || controller.signal.aborted) throw new Error(appendStatus(text, "Command aborted"));
		if (result.timedOut) throw new Error(appendStatus(text, `Command timed out after ${timeout} seconds`));
		if ((result.exitCode ?? 0) !== 0) throw new Error(appendStatus(text, `Command exited with code ${result.exitCode}`));
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
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { command, timeout } = params as { command: string; timeout?: number };
			return executeBashNative(command, ctx?.cwd ?? process.cwd(), timeout, signal, onUpdate as any);
		},
	});
}
