import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

type JsonObject = Record<string, unknown>;

export type ToolCallRecord = {
	tool: string;
	args?: JsonObject | null;
};

export type ArgCheck = {
	tool?: string;
	callIndex?: number;
	path: string;
	equals?: unknown;
	oneOf?: unknown[];
	includes?: unknown;
	optional?: boolean;
};

export type ToolCallEvalCase = {
	id: string;
	prompt: string;
	expectedTools?: string[];
	expectedSequence?: string[];
	forbiddenTools?: string[];
	argChecks?: ArgCheck[];
	tags?: string[];
	notes?: string;
};

export type ToolCallRun = {
	id: string;
	toolCalls: ToolCallRecord[];
	finalOutcome?: string;
	metadata?: JsonObject;
};

export type ArgCheckResult = {
	check: ArgCheck;
	pass: boolean;
	reason?: string;
};

export type CaseScore = {
	id: string;
	prompt: string;
	expectedPrimaryTool?: string;
	actualFirstTool?: string;
	actualTools: string[];
	missing: boolean;
	firstToolPass: boolean;
	lateExpectedTool: boolean;
	forbiddenToolUsed: boolean;
	sequencePass?: boolean;
	argResults: ArgCheckResult[];
	argPass: boolean;
	overallPass: boolean;
	softPass: boolean;
	reasons: string[];
};

export type EvaluationSummary = {
	totalCases: number;
	matchedRuns: number;
	missingRuns: number;
	overallPassCount: number;
	softPassCount: number;
	failCount: number;
	firstToolPassCount: number;
	firstToolAccuracy: number;
	argCheckPassCount: number;
	argCheckCount: number;
	argCheckAccuracy: number;
	argCasePassCount: number;
	argCaseAccuracy: number;
	sequenceCaseCount: number;
	sequencePassCount: number;
	sequenceAccuracy: number;
	bashOveruseCount: number;
	bashOveruseRate: number;
	confusionMatrix: Record<string, Record<string, number>>;
	extraRunIds: string[];
	caseScores: CaseScore[];
};

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function primaryExpectedTool(evalCase: ToolCallEvalCase): string | undefined {
	if (evalCase.expectedSequence && evalCase.expectedSequence.length > 0) return evalCase.expectedSequence[0];
	if (evalCase.expectedTools && evalCase.expectedTools.length > 0) return evalCase.expectedTools[0];
	return undefined;
}

function getValueAtPath(value: unknown, path: string): unknown {
	if (!path) return value;
	const segments = path.split(".");
	let current: unknown = value;
	for (const segment of segments) {
		if (Array.isArray(current)) {
			const index = Number(segment);
			if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
			current = current[index];
			continue;
		}
		if (!isObject(current) || !(segment in current)) return undefined;
		current = current[segment];
	}
	return current;
}

function includesValue(actual: unknown, expected: unknown): boolean {
	if (typeof actual === "string" && typeof expected === "string") return actual.includes(expected);
	if (Array.isArray(actual)) return actual.some((item) => isDeepStrictEqual(item, expected));
	return false;
}

function arraysEqual(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function parseJsonlLine<T>(line: string, label: string, lineNumber: number): T {
	try {
		return JSON.parse(line) as T;
	} catch (error: any) {
		throw new Error(`${label}: invalid JSON on line ${lineNumber}: ${error.message}`);
	}
}

export function parseJsonl<T>(content: string, label: string): T[] {
	const lines = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
	return lines.map((line, index) => parseJsonlLine<T>(line, label, index + 1));
}

function pickCall(run: ToolCallRun | undefined, check: ArgCheck): ToolCallRecord | undefined {
	if (!run) return undefined;
	if (check.callIndex !== undefined) return run.toolCalls[check.callIndex];
	if (check.tool) return run.toolCalls.find((call) => call.tool === check.tool);
	return run.toolCalls[0];
}

export function scoreArgCheck(check: ArgCheck, run: ToolCallRun | undefined): ArgCheckResult {
	const call = pickCall(run, check);
	if (!call) {
		return { check, pass: false, reason: `No tool call matched arg check for ${check.tool ?? "first call"}` };
	}
	const actual = getValueAtPath(call.args ?? {}, check.path);
	if (actual === undefined && check.optional) return { check, pass: true };
	if (check.equals !== undefined) {
		return isDeepStrictEqual(actual, check.equals)
			? { check, pass: true }
			: { check, pass: false, reason: `Expected ${check.path}=${JSON.stringify(check.equals)}, got ${JSON.stringify(actual)}` };
	}
	if (check.oneOf) {
		return check.oneOf.some((candidate) => isDeepStrictEqual(actual, candidate))
			? { check, pass: true }
			: { check, pass: false, reason: `Expected ${check.path} to be one of ${JSON.stringify(check.oneOf)}, got ${JSON.stringify(actual)}` };
	}
	if (check.includes !== undefined) {
		return includesValue(actual, check.includes)
			? { check, pass: true }
			: { check, pass: false, reason: `Expected ${check.path} to include ${JSON.stringify(check.includes)}, got ${JSON.stringify(actual)}` };
	}
	return { check, pass: actual !== undefined, reason: actual !== undefined ? undefined : `Missing ${check.path}` };
}

export function scoreCase(evalCase: ToolCallEvalCase, run: ToolCallRun | undefined): CaseScore {
	const expectedPrimaryTool = primaryExpectedTool(evalCase);
	const expectedTools = evalCase.expectedTools ?? (evalCase.expectedSequence ? [...new Set(evalCase.expectedSequence)] : []);
	const forbiddenTools = evalCase.forbiddenTools ?? [];
	const actualTools = run?.toolCalls.map((call) => call.tool) ?? [];
	const actualFirstTool = actualTools[0];
	const missing = !run;
	const firstToolPass = Boolean(expectedPrimaryTool) ? actualFirstTool === expectedPrimaryTool : actualTools.length > 0;
	const lateExpectedTool = expectedTools.length > 0 && actualTools.slice(1).some((tool) => expectedTools.includes(tool));
	const forbiddenToolUsed = actualTools.some((tool) => forbiddenTools.includes(tool));
	const sequencePass = evalCase.expectedSequence ? arraysEqual(actualTools, evalCase.expectedSequence) : undefined;
	const argResults = (evalCase.argChecks ?? []).map((check) => scoreArgCheck(check, run));
	const argPass = argResults.every((result) => result.pass);
	const reasons: string[] = [];

	if (missing) reasons.push("missing_result");
	if (!missing && !firstToolPass) reasons.push("wrong_first_tool");
	if (lateExpectedTool) reasons.push("expected_tool_found_late");
	if (forbiddenToolUsed) reasons.push("forbidden_tool_used");
	if (sequencePass === false) reasons.push("wrong_sequence");
	for (const argResult of argResults) {
		if (!argResult.pass && argResult.reason) reasons.push(argResult.reason);
	}

	const overallPass = !missing && firstToolPass && !forbiddenToolUsed && argPass && (sequencePass ?? true);
	const softPass = !overallPass && !missing && !forbiddenToolUsed && (lateExpectedTool || (expectedTools.length > 0 && actualTools.some((tool) => expectedTools.includes(tool))));

	return {
		id: evalCase.id,
		prompt: evalCase.prompt,
		expectedPrimaryTool,
		actualFirstTool,
		actualTools,
		missing,
		firstToolPass,
		lateExpectedTool,
		forbiddenToolUsed,
		sequencePass,
		argResults,
		argPass,
		overallPass,
		softPass,
		reasons,
	};
}

function ratio(numerator: number, denominator: number): number {
	return denominator === 0 ? 0 : numerator / denominator;
}

export function evaluateRuns(cases: ToolCallEvalCase[], runs: ToolCallRun[]): EvaluationSummary {
	const runById = new Map(runs.map((run) => [run.id, run]));
	const extraRunIds = runs.map((run) => run.id).filter((id) => !cases.some((evalCase) => evalCase.id === id));
	const caseScores = cases.map((evalCase) => scoreCase(evalCase, runById.get(evalCase.id)));
	const matchedRuns = caseScores.filter((score) => !score.missing).length;
	const missingRuns = caseScores.length - matchedRuns;
	const overallPassCount = caseScores.filter((score) => score.overallPass).length;
	const softPassCount = caseScores.filter((score) => !score.overallPass && score.softPass).length;
	const failCount = caseScores.length - overallPassCount - softPassCount;
	const firstToolPassCount = caseScores.filter((score) => score.firstToolPass).length;
	const argChecks = caseScores.flatMap((score) => score.argResults);
	const argCheckPassCount = argChecks.filter((result) => result.pass).length;
	const argCaseCount = caseScores.filter((score) => score.argResults.length > 0).length;
	const argCasePassCount = caseScores.filter((score) => score.argResults.length > 0 && score.argPass).length;
	const sequenceCases = caseScores.filter((score) => score.sequencePass !== undefined);
	const sequencePassCount = sequenceCases.filter((score) => score.sequencePass).length;
	const nonBashExpectedCases = caseScores.filter((score) => score.expectedPrimaryTool && score.expectedPrimaryTool !== "bash" && !score.missing);
	const bashOveruseCount = nonBashExpectedCases.filter((score) => score.actualTools.includes("bash")).length;
	const confusionMatrix: Record<string, Record<string, number>> = {};

	for (const score of caseScores) {
		const expected = score.expectedPrimaryTool ?? "(unspecified)";
		const actual = score.actualFirstTool ?? "(missing)";
		if (!confusionMatrix[expected]) confusionMatrix[expected] = {};
		confusionMatrix[expected]![actual] = (confusionMatrix[expected]![actual] ?? 0) + 1;
	}

	return {
		totalCases: caseScores.length,
		matchedRuns,
		missingRuns,
		overallPassCount,
		softPassCount,
		failCount,
		firstToolPassCount,
		firstToolAccuracy: ratio(firstToolPassCount, caseScores.length),
		argCheckPassCount,
		argCheckCount: argChecks.length,
		argCheckAccuracy: ratio(argCheckPassCount, argChecks.length),
		argCasePassCount,
		argCaseAccuracy: ratio(argCasePassCount, argCaseCount),
		sequenceCaseCount: sequenceCases.length,
		sequencePassCount,
		sequenceAccuracy: ratio(sequencePassCount, sequenceCases.length),
		bashOveruseCount,
		bashOveruseRate: ratio(bashOveruseCount, nonBashExpectedCases.length),
		confusionMatrix,
		extraRunIds,
		caseScores,
	};
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function topFailures(summary: EvaluationSummary, limit = 10): string[] {
	return summary.caseScores
		.filter((score) => !score.overallPass)
		.slice(0, limit)
		.map((score) => {
			const expected = score.expectedPrimaryTool ?? "(unspecified)";
			const actual = score.actualFirstTool ?? "(missing)";
			return `- ${score.id}: expected=${expected}, actual=${actual}, reasons=${score.reasons.join("; ") || "n/a"}`;
		});
}

export function formatSummary(summary: EvaluationSummary): string {
	const lines = [
		`Cases: ${summary.totalCases} total, ${summary.matchedRuns} matched, ${summary.missingRuns} missing`,
		`Overall: ${summary.overallPassCount} pass, ${summary.softPassCount} soft, ${summary.failCount} fail (${formatPercent(ratio(summary.overallPassCount, summary.totalCases))} strict pass)`,
		`First tool accuracy: ${summary.firstToolPassCount}/${summary.totalCases} (${formatPercent(summary.firstToolAccuracy)})`,
		summary.argCheckCount > 0
			? `Arg checks: ${summary.argCheckPassCount}/${summary.argCheckCount} (${formatPercent(summary.argCheckAccuracy)}), case pass ${summary.argCasePassCount} (${formatPercent(summary.argCaseAccuracy)})`
			: "Arg checks: none",
		summary.sequenceCaseCount > 0
			? `Sequence accuracy: ${summary.sequencePassCount}/${summary.sequenceCaseCount} (${formatPercent(summary.sequenceAccuracy)})`
			: "Sequence accuracy: n/a",
		`Bash overuse: ${summary.bashOveruseCount} (${formatPercent(summary.bashOveruseRate)})`,
	];

	if (summary.extraRunIds.length > 0) lines.push(`Extra run ids: ${summary.extraRunIds.join(", ")}`);
	lines.push("Confusion matrix:");
	for (const [expected, actuals] of Object.entries(summary.confusionMatrix)) {
		const counts = Object.entries(actuals)
			.map(([actual, count]) => `${actual}=${count}`)
			.join(", ");
		lines.push(`- ${expected}: ${counts}`);
	}
	const failures = topFailures(summary);
	if (failures.length > 0) {
		lines.push("Failures:");
		lines.push(...failures);
	}
	return lines.join("\n");
}

async function loadJsonlFile<T>(path: string, label: string): Promise<T[]> {
	const content = await readFile(path, "utf-8");
	return parseJsonl<T>(content, label);
}

export async function main(args: string[]): Promise<void> {
	if (args.length < 2) {
		console.error("Usage: node scripts/eval-tool-calls.ts <cases.jsonl> <runs.jsonl>");
		console.error("Example: node scripts/eval-tool-calls.ts evals/tool-calls.jsonl evals/tool-calls.results.jsonl");
		process.exitCode = 1;
		return;
	}

	const [casesPath, runsPath] = args;
	const cases = await loadJsonlFile<ToolCallEvalCase>(casesPath, casesPath);
	const runs = await loadJsonlFile<ToolCallRun>(runsPath, runsPath);
	const summary = evaluateRuns(cases, runs);
	console.log(formatSummary(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main(process.argv.slice(2));
}
