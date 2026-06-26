import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { ToolCallRecord, ToolCallRun } from "./eval-tool-calls.ts";

export type RawToolCallRun = Record<string, unknown>;

type JsonObject = Record<string, unknown>;

type RawToolCall = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickArray(container: JsonObject, keys: string[]): unknown[] | undefined {
	for (const key of keys) {
		const value = container[key];
		if (Array.isArray(value)) return value;
	}
	return undefined;
}

function pickString(container: JsonObject, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = container[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function maybeParseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function normalizeArgs(value: unknown): JsonObject | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value === "string") {
		const parsed = maybeParseJson(value);
		return isObject(parsed) ? parsed : { value: parsed };
	}
	if (isObject(value)) return value;
	return { value };
}

function normalizeToolCall(raw: unknown): ToolCallRecord | null {
	if (!isObject(raw)) return null;
	const fn = isObject(raw.function) ? raw.function : undefined;
	const tool = pickString(raw, ["tool", "name"]) ?? (fn ? pickString(fn, ["name"]) : undefined);
	if (!tool) return null;

	const args = normalizeArgs(
		raw.args ?? raw.arguments ?? raw.input ?? raw.parameters ?? raw.payload ?? (fn ? fn.arguments ?? fn.args ?? fn.input : undefined),
	);
	return { tool, args };
}

function normalizeToolCalls(raw: JsonObject): ToolCallRecord[] {
	const rawCalls = pickArray(raw, ["toolCalls", "tool_calls", "calls", "invocations"]);
	if (!rawCalls) return [];
	return rawCalls.map((call) => normalizeToolCall(call)).filter((call): call is ToolCallRecord => Boolean(call));
}

function normalizeMetadata(raw: JsonObject): JsonObject | undefined {
	return isObject(raw.metadata) ? raw.metadata : undefined;
}

export function normalizeRun(raw: unknown, index: number): ToolCallRun {
	if (!isObject(raw)) throw new Error(`Run ${index + 1} must be an object.`);
	const id = pickString(raw, ["id", "evalId", "caseId", "promptId", "traceId"]);
	if (!id) throw new Error(`Run ${index + 1} is missing id/caseId/evalId.`);
	const toolCalls = normalizeToolCalls(raw);
	if (toolCalls.length === 0) throw new Error(`Run ${id} has no recognizable tool calls.`);

	return {
		id,
		toolCalls,
		finalOutcome: pickString(raw, ["finalOutcome", "outcome", "status"]),
		metadata: normalizeMetadata(raw),
	};
}

export function extractRunsDocument(input: unknown): unknown[] {
	if (Array.isArray(input)) return input;
	if (!isObject(input)) throw new Error("Input must be a JSON array or an object containing runs.");
	const runs = pickArray(input, ["runs", "items", "records", "results"]);
	if (runs) return runs;
	return [input];
}

export function convertRunsInput(input: unknown): ToolCallRun[] {
	return extractRunsDocument(input).map((raw, index) => normalizeRun(raw, index));
}

export function formatRunsJsonl(runs: ToolCallRun[]): string {
	return `${runs.map((run) => JSON.stringify(run)).join("\n")}\n`;
}

export async function convertRunsFile(inputPath: string, outputPath: string): Promise<{ count: number }> {
	const raw = JSON.parse(await readFile(inputPath, "utf-8"));
	const runs = convertRunsInput(raw);
	await writeFile(outputPath, formatRunsJsonl(runs));
	return { count: runs.length };
}

export async function main(args: string[]): Promise<void> {
	if (args.length < 2) {
		console.error("Usage: node scripts/convert-tool-call-runs.ts <input.json> <output.jsonl>");
		console.error("Example: node scripts/convert-tool-call-runs.ts evals/tool-calls.raw-sample.json evals/tool-calls.results.jsonl");
		process.exitCode = 1;
		return;
	}

	const [inputPath, outputPath] = args;
	const result = await convertRunsFile(inputPath, outputPath);
	console.log(`Converted ${result.count} run(s) to ${outputPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main(process.argv.slice(2));
}
