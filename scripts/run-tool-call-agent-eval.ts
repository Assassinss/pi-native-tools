import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

type JsonObject = Record<string, unknown>;
type ToolCallRecord = { tool: string; args?: JsonObject | null };
type ToolCallEvalCase = { id: string; prompt: string };
type RegisteredModel = NonNullable<ReturnType<ModelRegistry["find"]>>;
type ModelResolution = {
	model: RegisteredModel;
	source: "cli-override" | "pi-default" | "first-available";
};
type ToolCallRunMetadata = {
	model: string;
	modelSource: ModelResolution["source"];
	thinkingLevel: NonNullable<AgentEvalOptions["thinkingLevel"]>;
	prompt: string;
	durationMs: number;
	toolCount: number;
	firstTool?: string;
	error?: string;
};
type ToolCallRun = {
	id: string;
	toolCalls: ToolCallRecord[];
	finalOutcome?: "ok" | "error";
	metadata?: ToolCallRunMetadata;
};

type AgentEvalOptions = {
	casesPath: string;
	outputPath: string;
	modelSelector?: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	caseId?: string;
	timeoutMs: number;
};

function parseArgs(argv: string[]): AgentEvalOptions {
	let casesPath = "evals/tool-calls.jsonl";
	let outputPath = ".tmp-pi-agent-eval/runs.jsonl";
	let modelSelector: string | undefined;
	let thinkingLevel: AgentEvalOptions["thinkingLevel"] = "off";
	let caseId: string | undefined;
	let timeoutMs = 60_000;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--cases") casesPath = argv[++i]!;
		else if (arg === "--out") outputPath = argv[++i]!;
		else if (arg === "--model") modelSelector = argv[++i]!;
		else if (arg === "--thinking") thinkingLevel = argv[++i] as AgentEvalOptions["thinkingLevel"];
		else if (arg === "--case") caseId = argv[++i]!;
		else if (arg === "--timeout-ms") timeoutMs = Number(argv[++i]!);
		else if (arg === "-h" || arg === "--help") {
			console.log("Usage: node scripts/run-tool-call-agent-eval.ts [--cases file] [--out file] [--model provider/id] [--thinking level] [--case id] [--timeout-ms n]");
			process.exit(0);
		}
	}

	return { casesPath, outputPath, modelSelector, thinkingLevel, caseId, timeoutMs };
}

function getProjectRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function parseJsonl<T>(content: string, sourcePath: string): T[] {
	return content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line, index) => {
			try {
				return JSON.parse(line) as T;
			} catch (error: any) {
				throw new Error(`Invalid JSONL in ${sourcePath} at line ${index + 1}: ${error?.message ?? String(error)}`);
			}
		});
}

function normalizeArgs(input: unknown): JsonObject | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return null;
	return input as JsonObject;
}

function collectToolCalls(events: AgentSessionEvent[]): ToolCallRecord[] {
	return events
		.filter((event): event is Extract<AgentSessionEvent, { type: "tool_execution_start" }> => event.type === "tool_execution_start")
		.map((event) => ({ tool: event.toolName, args: normalizeArgs(event.args) }));
}

function parseModelSelector(selector: string): { provider: string; modelId: string } | null {
	const slash = selector.indexOf("/");
	if (slash <= 0 || slash === selector.length - 1) return null;
	return { provider: selector.slice(0, slash), modelId: selector.slice(slash + 1) };
}

async function resolveModel(modelRegistry: ModelRegistry, settingsManager: SettingsManager, selector?: string): Promise<ModelResolution> {
	if (selector) {
		const parsed = parseModelSelector(selector);
		if (!parsed) throw new Error(`Invalid --model value: ${selector}. Expected provider/id.`);
		const model = modelRegistry.find(parsed.provider, parsed.modelId);
		if (!model) throw new Error(`Model not found: ${selector}`);
		if (!modelRegistry.hasConfiguredAuth(model)) throw new Error(`Model has no configured auth: ${selector}`);
		return { model, source: "cli-override" };
	}

	const defaultProvider = settingsManager.getDefaultProvider();
	const defaultModelId = settingsManager.getDefaultModel();
	if (defaultProvider && defaultModelId) {
		const model = modelRegistry.find(defaultProvider, defaultModelId);
		if (!model) throw new Error(`Pi selected model not found: ${defaultProvider}/${defaultModelId}`);
		if (!modelRegistry.hasConfiguredAuth(model)) throw new Error(`Pi selected model has no configured auth: ${defaultProvider}/${defaultModelId}`);
		return { model, source: "pi-default" };
	}

	const available = modelRegistry.getAvailable();
	if (available.length === 0) {
		throw new Error("No available models with configured auth. Set up a Pi provider/API key first.");
	}
	return { model: available[0]!, source: "first-available" };
}

function formatToolChain(toolCalls: ToolCallRecord[]): string {
	return toolCalls.map((call) => call.tool).join(" -> ") || "(none)";
}

function printRunSummary(run: ToolCallRun): void {
	const outcome = run.finalOutcome ?? "unknown";
	const durationMs = run.metadata?.durationMs ?? 0;
	const firstTool = run.metadata?.firstTool ?? "(none)";
	const detail = outcome === "error" && run.metadata?.error ? ` | error=${run.metadata.error}` : "";
	console.log(`  ${outcome} | ${durationMs}ms | first=${firstTool} | tools=${formatToolChain(run.toolCalls)}${detail}`);
}

function printOverallSummary(runs: ToolCallRun[]): void {
	const okCount = runs.filter((run) => run.finalOutcome === "ok").length;
	const errorCount = runs.filter((run) => run.finalOutcome === "error").length;
	const noToolCount = runs.filter((run) => run.toolCalls.length === 0).length;
	const totalDurationMs = runs.reduce((sum, run) => sum + (run.metadata?.durationMs ?? 0), 0);
	const firstToolCounts = new Map<string, number>();
	for (const run of runs) {
		const firstTool = run.metadata?.firstTool;
		if (!firstTool) continue;
		firstToolCounts.set(firstTool, (firstToolCounts.get(firstTool) ?? 0) + 1);
	}
	const firstTools = Array.from(firstToolCounts.entries())
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([tool, count]) => `${tool}=${count}`)
		.join(", ") || "(none)";
	const averageDurationMs = runs.length === 0 ? 0 : Math.round(totalDurationMs / runs.length);

	console.log("Summary:");
	console.log(`- ok: ${okCount}/${runs.length}`);
	console.log(`- error: ${errorCount}/${runs.length}`);
	console.log(`- no-tool: ${noToolCount}/${runs.length}`);
	console.log(`- avg duration: ${averageDurationMs}ms`);
	console.log(`- first tools: ${firstTools}`);
}

async function loadCases(path: string, caseId?: string): Promise<ToolCallEvalCase[]> {
	const content = await readFile(path, "utf-8");
	const cases = parseJsonl<ToolCallEvalCase>(content, path);
	if (!caseId) return cases;
	const filtered = cases.filter((item) => item.id === caseId);
	if (filtered.length === 0) throw new Error(`Case not found: ${caseId}`);
	return filtered;
}

async function createIsolatedLoader(projectRoot: string): Promise<DefaultResourceLoader> {
	const loader = new DefaultResourceLoader({
		cwd: projectRoot,
		agentDir: resolve(projectRoot, ".tmp-pi-agent-eval"),
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [resolve(projectRoot, "index.ts")],
	});
	await loader.reload();
	return loader;
}

async function runCase(evalCase: ToolCallEvalCase, options: {
	projectRoot: string;
	loader: DefaultResourceLoader;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	modelSelector?: string;
	settingsManager: SettingsManager;
	resolvedModel: ModelResolution;
	thinkingLevel: NonNullable<AgentEvalOptions["thinkingLevel"]>;
	timeoutMs: number;
}): Promise<ToolCallRun> {
	const { model, source } = options.resolvedModel;
	const sessionManager = SessionManager.inMemory(options.projectRoot);
	const { session } = await createAgentSession({
		cwd: options.projectRoot,
		agentDir: resolve(options.projectRoot, ".tmp-pi-agent-eval"),
		resourceLoader: options.loader,
		authStorage: options.authStorage,
		modelRegistry: options.modelRegistry,
		model,
		thinkingLevel: options.thinkingLevel,
		sessionManager,
		settingsManager: SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	});

	const events: AgentSessionEvent[] = [];
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end" || event.type === "tool_call") {
			events.push(event);
		}
	});
	const startedAt = Date.now();

	try {
		await session.bindExtensions({
			mode: "print",
			onError(error) {
				console.error(`[extension:${error.event}] ${error.error}`);
			},
		});

		await Promise.race([
			session.prompt(evalCase.prompt),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Case timed out after ${options.timeoutMs}ms`)), options.timeoutMs)),
		]);

		const toolCalls = collectToolCalls(events);
		return {
			id: evalCase.id,
			toolCalls,
			finalOutcome: "ok",
			metadata: {
				model: `${model.provider}/${model.id}`,
				modelSource: source,
				thinkingLevel: options.thinkingLevel,
				prompt: evalCase.prompt,
				durationMs: Date.now() - startedAt,
				toolCount: toolCalls.length,
				firstTool: toolCalls[0]?.tool,
			},
		};
	} catch (error: any) {
		const toolCalls = collectToolCalls(events);
		return {
			id: evalCase.id,
			toolCalls,
			finalOutcome: "error",
			metadata: {
				model: `${model.provider}/${model.id}`,
				modelSource: source,
				thinkingLevel: options.thinkingLevel,
				prompt: evalCase.prompt,
				durationMs: Date.now() - startedAt,
				toolCount: toolCalls.length,
				firstTool: toolCalls[0]?.tool,
				error: error?.message ?? String(error),
			},
		};
	} finally {
		unsubscribe();
		session.dispose();
	}
}

function formatRunsJsonl(runs: ToolCallRun[]): string {
	return runs.map((run) => JSON.stringify(run)).join("\n") + "\n";
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const projectRoot = getProjectRoot();
	const cases = await loadCases(resolve(projectRoot, options.casesPath), options.caseId);
	const authStorage = AuthStorage.create();
	const modelRegistry = ModelRegistry.create(authStorage);
	const settingsManager = SettingsManager.create(projectRoot);
	const loader = await createIsolatedLoader(projectRoot);
	const resolvedModel = await resolveModel(modelRegistry, settingsManager, options.modelSelector);
	const thinkingLevel = options.thinkingLevel ?? settingsManager.getDefaultThinkingLevel() ?? "off";
	console.log(`Running ${cases.length} case(s) with ${resolvedModel.model.provider}/${resolvedModel.model.id}...`);
	console.log(`Model source: ${resolvedModel.source}`);
	console.log(`Thinking level: ${thinkingLevel}`);
	console.log(`Cases file: ${resolve(projectRoot, options.casesPath)}`);

	const runs: ToolCallRun[] = [];
	for (const evalCase of cases) {
		console.log(`- ${evalCase.id}: ${evalCase.prompt}`);
		const run = await runCase(evalCase, {
			projectRoot,
			loader,
			authStorage,
			modelRegistry,
			modelSelector: `${resolvedModel.model.provider}/${resolvedModel.model.id}`,
			settingsManager,
			resolvedModel,
			thinkingLevel,
			timeoutMs: options.timeoutMs,
		});
		printRunSummary(run);
		runs.push(run);
	}

	const outPath = resolve(projectRoot, options.outputPath);
	await mkdir(dirname(outPath), { recursive: true });
	await writeFile(outPath, formatRunsJsonl(runs), "utf-8");
	console.log(`Wrote runs to ${outPath}`);
	printOverallSummary(runs);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
