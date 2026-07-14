import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	createBashToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { executeBashNative } from "../extensions/bash.ts";
import { executeFindNative } from "../extensions/find.ts";
import { executeGrepNative } from "../extensions/grep.ts";
import { executeShell, invalidateFsScanCache } from "../extensions/omp-native.ts";

const FILE_COUNT = 2400;
const DIR_COUNT = 48;
const FIND_RUNS = 8;
const GREP_RUNS = 8;
const BASH_RUNS = 20;
const CONCURRENCY_LEVELS = [4, 8];
const CONCURRENCY_RUNS = 4;

type MemorySample = {
	rss: number;
	heapUsed: number;
};

type MemoryDelta = {
	peakRssDeltaBytes: number;
	peakHeapDeltaBytes: number;
};

type TimedSeries = { coldMs: number; coldMemory: MemoryDelta; warmRuns: number[]; warmMemory: MemoryDelta[] };
type ConcurrentSeries = { runs: number[]; memoryRuns: MemoryDelta[] };

type BashSeries = {
	oneShotRuns: number[];
	oneShotMemory: MemoryDelta[];
	firstSessionMs?: number;
	firstSessionMemory?: MemoryDelta;
	reusedRuns?: number[];
	reusedMemory?: MemoryDelta[];
};

function mean(values: number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function formatMs(value: number): string {
	return `${value.toFixed(1)} ms`;
}

function formatMiB(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function ratio(base: number, candidate: number): string {
	if (candidate <= 0) return base <= 0 ? "1.00x" : "inf";
	return `${(base / candidate).toFixed(2)}x`;
}

function snapshotMemory(): MemorySample {
	const { rss, heapUsed } = process.memoryUsage();
	return { rss, heapUsed };
}

async function settleMemory(): Promise<void> {
	globalThis.gc?.();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function time<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T; memory: MemoryDelta }> {
	await settleMemory();
	const before = snapshotMemory();
	let peakRss = before.rss;
	let peakHeapUsed = before.heapUsed;
	const timer = setInterval(() => {
		const current = snapshotMemory();
		peakRss = Math.max(peakRss, current.rss);
		peakHeapUsed = Math.max(peakHeapUsed, current.heapUsed);
	}, 10);
	timer.unref?.();
	const start = performance.now();
	try {
		const value = await fn();
		const after = snapshotMemory();
		peakRss = Math.max(peakRss, after.rss);
		peakHeapUsed = Math.max(peakHeapUsed, after.heapUsed);
		return {
			ms: performance.now() - start,
			value,
			memory: {
				peakRssDeltaBytes: Math.max(0, peakRss - before.rss),
				peakHeapDeltaBytes: Math.max(0, peakHeapUsed - before.heapUsed),
			},
		};
	} finally {
		clearInterval(timer);
	}
}

async function buildFixture(root: string): Promise<void> {
	for (let dirIndex = 0; dirIndex < DIR_COUNT; dirIndex++) {
		const dir = join(root, `group-${String(dirIndex).padStart(2, "0")}`);
		await mkdir(dir, { recursive: true });
	}

	const writes: Promise<unknown>[] = [];
	for (let fileIndex = 0; fileIndex < FILE_COUNT; fileIndex++) {
		const dir = join(root, `group-${String(fileIndex % DIR_COUNT).padStart(2, "0")}`);
		const ext = fileIndex % 3 === 0 ? "ts" : fileIndex % 3 === 1 ? "js" : "txt";
		const file = join(dir, `file-${String(fileIndex).padStart(4, "0")}.${ext}`);
		const hasNeedle = fileIndex % 7 === 0;
		const body = [
			`export const file${fileIndex} = ${fileIndex};`,
			"const block = [1, 2, 3, 4, 5].join(',');",
			hasNeedle ? `const needle = \"match-${fileIndex}\";` : `const filler = \"miss-${fileIndex}\";`,
			"function noop() { return block.length; }",
			"noop();",
		].join("\n");
		writes.push(writeFile(file, `${body}\n`, "utf-8"));
	}
	await Promise.all(writes);
}

async function benchmarkSeries(runs: number, fn: () => Promise<unknown>, invalidateRoot?: string): Promise<TimedSeries> {
	if (invalidateRoot) invalidateFsScanCache?.(invalidateRoot);
	const cold = await time(fn);
	const warmRuns: number[] = [];
	const warmMemory: MemoryDelta[] = [];
	for (let i = 0; i < runs; i++) {
		const run = await time(fn);
		warmRuns.push(run.ms);
		warmMemory.push(run.memory);
	}
	return { coldMs: cold.ms, coldMemory: cold.memory, warmRuns, warmMemory };
}

async function benchmarkConcurrentSeries(
	concurrency: number,
	fn: () => Promise<unknown>,
	invalidateRoot?: string,
): Promise<ConcurrentSeries> {
	const runs: number[] = [];
	const memoryRuns: MemoryDelta[] = [];
	for (let i = 0; i < CONCURRENCY_RUNS; i++) {
		if (invalidateRoot) invalidateFsScanCache?.(invalidateRoot);
		const run = await time(() => Promise.all(Array.from({ length: concurrency }, () => fn())));
		runs.push(run.ms);
		memoryRuns.push(run.memory);
	}
	return { runs, memoryRuns };
}

async function benchmarkFindNative(root: string): Promise<TimedSeries> {
	return benchmarkSeries(FIND_RUNS, () => executeFindNative("**/*.ts", undefined, FILE_COUNT, root, undefined), root);
}

async function benchmarkFindBuiltin(root: string): Promise<TimedSeries> {
	const tool = createFindToolDefinition(root);
	return benchmarkSeries(
		FIND_RUNS,
		() => tool.execute("bench-find", { pattern: "**/*.ts", limit: FILE_COUNT }, undefined, undefined, { cwd: root }),
	);
}

async function benchmarkFindConcurrentNative(root: string, concurrency: number): Promise<ConcurrentSeries> {
	return benchmarkConcurrentSeries(
		concurrency,
		() => executeFindNative("**/*.ts", undefined, FILE_COUNT, root, undefined),
		root,
	);
}

async function benchmarkFindConcurrentBuiltin(root: string, concurrency: number): Promise<ConcurrentSeries> {
	const tool = createFindToolDefinition(root);
	return benchmarkConcurrentSeries(
		concurrency,
		() => tool.execute("bench-find", { pattern: "**/*.ts", limit: FILE_COUNT }, undefined, undefined, { cwd: root }),
	);
}

async function benchmarkGrepNative(root: string): Promise<TimedSeries> {
	return benchmarkSeries(
		GREP_RUNS,
		() => executeGrepNative({ pattern: "needle", context: 0, limit: FILE_COUNT, cwd: root }),
		root,
	);
}

async function benchmarkGrepBuiltin(root: string): Promise<TimedSeries> {
	const tool = createGrepToolDefinition(root);
	return benchmarkSeries(
		GREP_RUNS,
		() => tool.execute("bench-grep", { pattern: "needle", limit: FILE_COUNT }, undefined, undefined, { cwd: root }),
	);
}

async function benchmarkGrepConcurrentNative(root: string, concurrency: number): Promise<ConcurrentSeries> {
	return benchmarkConcurrentSeries(
		concurrency,
		() => executeGrepNative({ pattern: "needle", context: 0, limit: FILE_COUNT, cwd: root }),
		root,
	);
}

async function benchmarkGrepConcurrentBuiltin(root: string, concurrency: number): Promise<ConcurrentSeries> {
	const tool = createGrepToolDefinition(root);
	return benchmarkConcurrentSeries(
		concurrency,
		() => tool.execute("bench-grep", { pattern: "needle", limit: FILE_COUNT }, undefined, undefined, { cwd: root }),
	);
}

async function benchmarkBashNative(root: string): Promise<BashSeries> {
	const oneShotRuns: number[] = [];
	const oneShotMemory: MemoryDelta[] = [];
	for (let i = 0; i < BASH_RUNS; i++) {
		const run = await time(() => executeShell({ command: "pwd", cwd: root }, undefined));
		oneShotRuns.push(run.ms);
		oneShotMemory.push(run.memory);
	}
	const firstSession = await time(() => executeBashNative("pwd", root, undefined, undefined));
	const reusedRuns: number[] = [];
	const reusedMemory: MemoryDelta[] = [];
	for (let i = 0; i < BASH_RUNS; i++) {
		const run = await time(() => executeBashNative("pwd", root, undefined, undefined));
		reusedRuns.push(run.ms);
		reusedMemory.push(run.memory);
	}
	return {
		oneShotRuns,
		oneShotMemory,
		firstSessionMs: firstSession.ms,
		firstSessionMemory: firstSession.memory,
		reusedRuns,
		reusedMemory,
	};
}

async function benchmarkBashBuiltin(root: string): Promise<BashSeries> {
	const tool = createBashToolDefinition(root);
	const oneShotRuns: number[] = [];
	const oneShotMemory: MemoryDelta[] = [];
	for (let i = 0; i < BASH_RUNS; i++) {
		const run = await time(() => tool.execute("bench-bash", { command: "pwd" }, undefined, undefined, { cwd: root }));
		oneShotRuns.push(run.ms);
		oneShotMemory.push(run.memory);
	}
	return { oneShotRuns, oneShotMemory };
}

function meanPeakRss(memoryRuns: MemoryDelta[]): number {
	return mean(memoryRuns.map((run) => run.peakRssDeltaBytes));
}

function meanPeakHeap(memoryRuns: MemoryDelta[]): number {
	return mean(memoryRuns.map((run) => run.peakHeapDeltaBytes));
}

function printSeries(label: string, series: TimedSeries) {
	console.log(
		`${label}: cold=${formatMs(series.coldMs)}, warm mean=${formatMs(mean(series.warmRuns))}, warm median=${formatMs(median(series.warmRuns))}, best=${formatMs(Math.min(...series.warmRuns))}, worst=${formatMs(Math.max(...series.warmRuns))}`,
	);
	console.log(
		`${label} mem: cold peak rss=${formatMiB(series.coldMemory.peakRssDeltaBytes)}, cold peak heap=${formatMiB(series.coldMemory.peakHeapDeltaBytes)}, warm peak rss mean=${formatMiB(meanPeakRss(series.warmMemory))}, warm peak heap mean=${formatMiB(meanPeakHeap(series.warmMemory))}`,
	);
}

function printConcurrentSeries(label: string, series: ConcurrentSeries) {
	console.log(
		`${label}: mean=${formatMs(mean(series.runs))}, median=${formatMs(median(series.runs))}, best=${formatMs(Math.min(...series.runs))}, worst=${formatMs(Math.max(...series.runs))}`,
	);
	console.log(
		`${label} mem: peak rss mean=${formatMiB(meanPeakRss(series.memoryRuns))}, peak heap mean=${formatMiB(meanPeakHeap(series.memoryRuns))}`,
	);
}

function printCompare(label: string, builtin: TimedSeries, native: TimedSeries) {
	console.log(
		`${label} compare: cold ${ratio(builtin.coldMs, native.coldMs)} native, warm mean ${ratio(mean(builtin.warmRuns), mean(native.warmRuns))} native, warm median ${ratio(median(builtin.warmRuns), median(native.warmRuns))} native`,
	);
	console.log(
		`${label} mem compare: warm peak rss ${ratio(meanPeakRss(builtin.warmMemory), meanPeakRss(native.warmMemory))} native, warm peak heap ${ratio(meanPeakHeap(builtin.warmMemory), meanPeakHeap(native.warmMemory))} native`,
	);
}

function printConcurrentCompare(label: string, builtin: ConcurrentSeries, native: ConcurrentSeries) {
	console.log(
		`${label} compare: mean ${ratio(mean(builtin.runs), mean(native.runs))} native, median ${ratio(median(builtin.runs), median(native.runs))} native`,
	);
	console.log(
		`${label} mem compare: peak rss ${ratio(meanPeakRss(builtin.memoryRuns), meanPeakRss(native.memoryRuns))} native, peak heap ${ratio(meanPeakHeap(builtin.memoryRuns), meanPeakHeap(native.memoryRuns))} native`,
	);
}

async function runBench<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
	try {
		return await fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.log(`${label}: skipped (${message})`);
		return null;
	}
}

async function main() {
	const root = await mkdtemp(join(tmpdir(), "pi-native-bench-"));
	try {
		console.log(`fixture: ${root}`);
		console.log(`files: ${FILE_COUNT}, dirs: ${DIR_COUNT}`);
		console.log(`memory sampling: peak process rss/heap deltas${globalThis.gc ? ", gc before each run" : ", no forced gc"}`);
		await buildFixture(root);

		const [findBuiltin, findNative, grepBuiltin, grepNative, bashBuiltin, bashNative] = await Promise.all([
			runBench("find builtin", () => benchmarkFindBuiltin(root)),
			runBench("find native", () => benchmarkFindNative(root)),
			runBench("grep builtin", () => benchmarkGrepBuiltin(root)),
			runBench("grep native", () => benchmarkGrepNative(root)),
			runBench("bash builtin", () => benchmarkBashBuiltin(root)),
			runBench("bash native", () => benchmarkBashNative(root)),
		]);

		if (findBuiltin) printSeries("find builtin", findBuiltin);
		if (findNative) printSeries("find native", findNative);
		if (findBuiltin && findNative) printCompare("find", findBuiltin, findNative);

		if (grepBuiltin) printSeries("grep builtin", grepBuiltin);
		if (grepNative) printSeries("grep native", grepNative);
		if (grepBuiltin && grepNative) printCompare("grep", grepBuiltin, grepNative);

		for (const concurrency of CONCURRENCY_LEVELS) {
			const [findConcurrentBuiltin, findConcurrentNative, grepConcurrentBuiltin, grepConcurrentNative] = await Promise.all([
				runBench(`find builtin x${concurrency}`, () => benchmarkFindConcurrentBuiltin(root, concurrency)),
				runBench(`find native x${concurrency}`, () => benchmarkFindConcurrentNative(root, concurrency)),
				runBench(`grep builtin x${concurrency}`, () => benchmarkGrepConcurrentBuiltin(root, concurrency)),
				runBench(`grep native x${concurrency}`, () => benchmarkGrepConcurrentNative(root, concurrency)),
			]);
			if (findConcurrentBuiltin) printConcurrentSeries(`find builtin x${concurrency}`, findConcurrentBuiltin);
			if (findConcurrentNative) printConcurrentSeries(`find native x${concurrency}`, findConcurrentNative);
			if (findConcurrentBuiltin && findConcurrentNative) {
				printConcurrentCompare(`find x${concurrency}`, findConcurrentBuiltin, findConcurrentNative);
			}
			if (grepConcurrentBuiltin) printConcurrentSeries(`grep builtin x${concurrency}`, grepConcurrentBuiltin);
			if (grepConcurrentNative) printConcurrentSeries(`grep native x${concurrency}`, grepConcurrentNative);
			if (grepConcurrentBuiltin && grepConcurrentNative) {
				printConcurrentCompare(`grep x${concurrency}`, grepConcurrentBuiltin, grepConcurrentNative);
			}
		}

		if (bashBuiltin) {
			console.log(
				`bash builtin: mean=${formatMs(mean(bashBuiltin.oneShotRuns))}, median=${formatMs(median(bashBuiltin.oneShotRuns))}, best=${formatMs(Math.min(...bashBuiltin.oneShotRuns))}, worst=${formatMs(Math.max(...bashBuiltin.oneShotRuns))}`,
			);
			console.log(
				`bash builtin mem: one-shot peak rss mean=${formatMiB(meanPeakRss(bashBuiltin.oneShotMemory))}, one-shot peak heap mean=${formatMiB(meanPeakHeap(bashBuiltin.oneShotMemory))}`,
			);
		}
		if (bashNative) {
			console.log(
				`bash native: one-shot mean=${formatMs(mean(bashNative.oneShotRuns))}, one-shot median=${formatMs(median(bashNative.oneShotRuns))}, session first=${formatMs(bashNative.firstSessionMs ?? 0)}, session reused mean=${formatMs(mean(bashNative.reusedRuns ?? []))}, session reused median=${formatMs(median(bashNative.reusedRuns ?? []))}`,
			);
			console.log(
				`bash native mem: one-shot peak rss mean=${formatMiB(meanPeakRss(bashNative.oneShotMemory))}, one-shot peak heap mean=${formatMiB(meanPeakHeap(bashNative.oneShotMemory))}, session first peak rss=${formatMiB(bashNative.firstSessionMemory?.peakRssDeltaBytes ?? 0)}, session reused peak rss mean=${formatMiB(meanPeakRss(bashNative.reusedMemory ?? []))}`,
			);
		}
		if (bashBuiltin && bashNative?.reusedRuns?.length && bashNative.reusedMemory?.length) {
			console.log(
				`bash compare: native one-shot ${ratio(mean(bashBuiltin.oneShotRuns), mean(bashNative.oneShotRuns))} builtin, native session reused ${ratio(mean(bashBuiltin.oneShotRuns), mean(bashNative.reusedRuns))} builtin`,
			);
			console.log(
				`bash mem compare: native one-shot peak rss ${ratio(meanPeakRss(bashBuiltin.oneShotMemory), meanPeakRss(bashNative.oneShotMemory))} builtin, native session reused peak rss ${ratio(meanPeakRss(bashBuiltin.oneShotMemory), meanPeakRss(bashNative.reusedMemory))} builtin`,
			);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

await main();
