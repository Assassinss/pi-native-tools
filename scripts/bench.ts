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

type TimedSeries = { coldMs: number; warmRuns: number[] };
type ConcurrentSeries = { runs: number[] };

type BashSeries = {
	oneShotRuns: number[];
	firstSessionMs?: number;
	reusedRuns?: number[];
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

function ratio(base: number, candidate: number): string {
	return `${(base / candidate).toFixed(2)}x`;
}

async function time<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
	const start = performance.now();
	const value = await fn();
	return { ms: performance.now() - start, value };
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
	for (let i = 0; i < runs; i++) warmRuns.push((await time(fn)).ms);
	return { coldMs: cold.ms, warmRuns };
}

async function benchmarkConcurrentSeries(
	concurrency: number,
	fn: () => Promise<unknown>,
	invalidateRoot?: string,
): Promise<ConcurrentSeries> {
	const runs: number[] = [];
	for (let i = 0; i < CONCURRENCY_RUNS; i++) {
		if (invalidateRoot) invalidateFsScanCache?.(invalidateRoot);
		runs.push((await time(() => Promise.all(Array.from({ length: concurrency }, () => fn())))).ms);
	}
	return { runs };
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
		() => executeGrepNative("needle", undefined, undefined, false, false, 0, FILE_COUNT, root, undefined),
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
		() => executeGrepNative("needle", undefined, undefined, false, false, 0, FILE_COUNT, root, undefined),
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
	for (let i = 0; i < BASH_RUNS; i++) {
		oneShotRuns.push((await time(() => executeShell({ command: "pwd", cwd: root }, undefined))).ms);
	}
	const firstSession = await time(() => executeBashNative("pwd", root, undefined, undefined));
	const reusedRuns: number[] = [];
	for (let i = 0; i < BASH_RUNS; i++) {
		reusedRuns.push((await time(() => executeBashNative("pwd", root, undefined, undefined))).ms);
	}
	return { oneShotRuns, firstSessionMs: firstSession.ms, reusedRuns };
}

async function benchmarkBashBuiltin(root: string): Promise<BashSeries> {
	const tool = createBashToolDefinition(root);
	const oneShotRuns: number[] = [];
	for (let i = 0; i < BASH_RUNS; i++) {
		oneShotRuns.push((await time(() => tool.execute("bench-bash", { command: "pwd" }, undefined, undefined, { cwd: root }))).ms);
	}
	return { oneShotRuns };
}

function printSeries(label: string, series: TimedSeries) {
	console.log(
		`${label}: cold=${formatMs(series.coldMs)}, warm mean=${formatMs(mean(series.warmRuns))}, warm median=${formatMs(median(series.warmRuns))}, best=${formatMs(Math.min(...series.warmRuns))}, worst=${formatMs(Math.max(...series.warmRuns))}`,
	);
}

function printConcurrentSeries(label: string, series: ConcurrentSeries) {
	console.log(
		`${label}: mean=${formatMs(mean(series.runs))}, median=${formatMs(median(series.runs))}, best=${formatMs(Math.min(...series.runs))}, worst=${formatMs(Math.max(...series.runs))}`,
	);
}

function printCompare(label: string, builtin: TimedSeries, native: TimedSeries) {
	console.log(
		`${label} compare: cold ${ratio(builtin.coldMs, native.coldMs)} native, warm mean ${ratio(mean(builtin.warmRuns), mean(native.warmRuns))} native, warm median ${ratio(median(builtin.warmRuns), median(native.warmRuns))} native`,
	);
}

function printConcurrentCompare(label: string, builtin: ConcurrentSeries, native: ConcurrentSeries) {
	console.log(
		`${label} compare: mean ${ratio(mean(builtin.runs), mean(native.runs))} native, median ${ratio(median(builtin.runs), median(native.runs))} native`,
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
		}
		if (bashNative) {
			console.log(
				`bash native: one-shot mean=${formatMs(mean(bashNative.oneShotRuns))}, one-shot median=${formatMs(median(bashNative.oneShotRuns))}, session first=${formatMs(bashNative.firstSessionMs ?? 0)}, session reused mean=${formatMs(mean(bashNative.reusedRuns ?? []))}, session reused median=${formatMs(median(bashNative.reusedRuns ?? []))}`,
			);
		}
		if (bashBuiltin && bashNative?.reusedRuns?.length) {
			console.log(
				`bash compare: native one-shot ${ratio(mean(bashBuiltin.oneShotRuns), mean(bashNative.oneShotRuns))} builtin, native session reused ${ratio(mean(bashBuiltin.oneShotRuns), mean(bashNative.reusedRuns))} builtin`,
			);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

await main();
