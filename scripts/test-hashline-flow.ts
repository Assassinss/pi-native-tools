import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
};

type ToolDef = {
	name: string;
	execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
		ctx: { cwd: string },
	) => Promise<ToolResult>;
};

type ChangedRange = {
	start: number;
	end: number;
	hashlines: string[];
	truncated?: boolean;
};

type EditDetails = {
	revisionId?: string;
	rebaseState?: string;
	changedRanges?: ChangedRange[];
};

type ReadDetails = {
	revisionId?: string;
};

function createPiStub() {
	const tools = new Map<string, ToolDef>();
	return {
		registerTool(def: ToolDef) {
			tools.set(def.name, def);
		},
		on(_event: string, _handler: unknown) {},
		tools,
	};
}

function extractText(result: ToolResult): string {
	return result.content.map((item) => item.text).join("\n");
}

function findHashlineByText(text: string, needle: string): string {
	const line = text.split("\n").find((entry) => entry.includes(`|${needle}`));
	assert.ok(line, `missing hashline for ${needle}`);
	return line.split("|", 2)[0]!;
}

function logHeader(title: string) {
	console.log(`\n=== ${title} ===`);
}

function logPass(message: string) {
	console.log(`PASS ${message}`);
}

function logFail(message: string, error: unknown) {
	const text = error instanceof Error ? error.message : String(error);
	console.log(`FAIL ${message}`);
	console.log(text);
}

function summarizeChangedRanges(details: EditDetails | undefined): string {
	const ranges = details?.changedRanges ?? [];
	if (ranges.length === 0) return "none";
	return ranges
		.map((range) => `${range.start}-${range.end} (${range.hashlines.length} lines${range.truncated ? ", truncated" : ""})`)
		.join(", ");
}

async function main() {
	const dir = await mkdtemp(join(tmpdir(), "pi-tools-hashline-flow-"));
	let failures = 0;
	try {
		const pi = createPiStub();
		extension(pi as any);
		const read = pi.tools.get("read");
		const write = pi.tools.get("write");
		const edit = pi.tools.get("edit");
		assert.ok(read);
		assert.ok(write);
		assert.ok(edit);

		logHeader("Scenario 1: changedRanges continuation");
		try {
			const file = join(dir, "demo.txt");
			await write!.execute("1", { path: file, content: "first\nsecond\nthird\nfourth\n" }, undefined, undefined, { cwd: dir });
			const readResult = await read!.execute("2", { path: file, withHashlines: true }, undefined, undefined, { cwd: dir });
			const readText = extractText(readResult);
			const revisionId = (readResult.details as ReadDetails | undefined)?.revisionId;
			assert.ok(revisionId, "missing read revisionId");
			const secondHashline = findHashlineByText(readText, "second");
			const firstEdit = await edit!.execute(
				"3",
				{ path: file, baseRevisionId: revisionId, edits: [{ hashline: secondHashline, newText: "inserted-1\ninserted-2", wholeLine: false }] },
				undefined,
				undefined,
				{ cwd: dir },
			);
			const firstDetails = firstEdit.details as EditDetails | undefined;
			const firstText = extractText(firstEdit);
			assert.match(firstText, /revisionId: rev_/);
			assert.match(firstText, /\[changed lines /);
			const secondEditRevisionId = firstDetails?.revisionId;
			assert.ok(secondEditRevisionId, "missing edit revisionId");
			const thirdHashline = findHashlineByText(firstText, "third");
			const secondEdit = await edit!.execute(
				"4",
				{ path: file, baseRevisionId: secondEditRevisionId, edits: [{ hashline: thirdHashline, newText: "THIRD" }] },
				undefined,
				undefined,
				{ cwd: dir },
			);
			const finalContent = await readFile(file, "utf-8");
			assert.equal(finalContent, "first\nsecond\ninserted-1\ninserted-2\nTHIRD\nfourth\n");
			logPass(`reused changedRanges without re-read | revision=${secondEditRevisionId} | changedRanges=${summarizeChangedRanges(secondEdit.details as EditDetails | undefined)}`);
		} catch (error) {
			failures++;
			logFail("changedRanges continuation", error);
		}

		logHeader("Scenario 2: automatic rebase from stale hashline");
		try {
			const file = join(dir, "rebase.txt");
			await write!.execute("5", { path: file, content: "first\nsecond\nthird\n" }, undefined, undefined, { cwd: dir });
			const readResult = await read!.execute("6", { path: file, withHashlines: true }, undefined, undefined, { cwd: dir });
			const readText = extractText(readResult);
			const revisionId = (readResult.details as ReadDetails | undefined)?.revisionId;
			assert.ok(revisionId, "missing read revisionId");
			const secondHashline = findHashlineByText(readText, "second");
			const thirdHashline = findHashlineByText(readText, "third");
			await edit!.execute(
				"7",
				{ path: file, baseRevisionId: revisionId, edits: [{ hashline: secondHashline, newText: "inserted-a\ninserted-b", wholeLine: false }] },
				undefined,
				undefined,
				{ cwd: dir },
			);
			const secondEdit = await edit!.execute(
				"8",
				{ path: file, baseRevisionId: revisionId, edits: [{ hashline: thirdHashline, newText: "THIRD" }] },
				undefined,
				undefined,
				{ cwd: dir },
			);
			const details = secondEdit.details as EditDetails | undefined;
			assert.equal(details?.rebaseState, "rebased");
			assert.match(extractText(secondEdit), /automatic rebase/i);
			logPass(`stale hashline rebased | revision=${details?.revisionId} | rebaseState=${details?.rebaseState} | changedRanges=${summarizeChangedRanges(details)}`);
		} catch (error) {
			failures++;
			logFail("automatic rebase from stale hashline", error);
		}

		logHeader("Scenario 3: large file / streaming window fallback");
		try {
			const file = join(dir, "big.txt");
			const content = Array.from({ length: 400000 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
			await write!.execute("9", { path: file, content }, undefined, undefined, { cwd: dir });
			const readResult = await read!.execute(
				"10",
				{ path: file, offset: 1, limit: 3, withHashlines: true },
				undefined,
				undefined,
				{ cwd: dir },
			);
			const readText = extractText(readResult);
			const revisionId = (readResult.details as ReadDetails | undefined)?.revisionId;
			assert.ok(revisionId, "missing streaming revisionId");
			const line2Hashline = findHashlineByText(readText, "line-2");
			const line3Hashline = findHashlineByText(readText, "line-3");
			await edit!.execute(
				"11",
				{ path: file, baseRevisionId: revisionId, edits: [{ hashline: line2Hashline, newText: "inserted-x\ninserted-y", wholeLine: false }] },
				undefined,
				undefined,
				{ cwd: dir },
			);
			const secondEdit = await edit!.execute(
				"12",
				{ path: file, baseRevisionId: revisionId, edits: [{ hashline: line3Hashline, newText: "LINE-3" }] },
				undefined,
				undefined,
				{ cwd: dir },
			);
			const finalContent = await readFile(file, "utf-8");
			assert.match(finalContent, /^line-1\nline-2\ninserted-x\ninserted-y\nLINE-3\n/);
			const details = secondEdit.details as EditDetails | undefined;
			logPass(`window snapshot fallback worked | revision=${details?.revisionId} | rebaseState=${details?.rebaseState} | changedRanges=${summarizeChangedRanges(details)}`);
		} catch (error) {
			failures++;
			logFail("large file / streaming window fallback", error);
		}

		logHeader("Scenario 4: external change should request refresh");
		try {
			const file = join(dir, "external.txt");
			await write!.execute("13", { path: file, content: "first\nsecond\nthird\n" }, undefined, undefined, { cwd: dir });
			const readResult = await read!.execute("14", { path: file, withHashlines: true }, undefined, undefined, { cwd: dir });
			const readText = extractText(readResult);
			const revisionId = (readResult.details as ReadDetails | undefined)?.revisionId;
			assert.ok(revisionId, "missing read revisionId");
			const thirdHashline = findHashlineByText(readText, "third");
			await write!.execute("15", { path: file, content: "first\nsecond\nchanged externally\n" }, undefined, undefined, { cwd: dir });
			let sawRefresh = false;
			try {
				await edit!.execute(
					"16",
					{ path: file, baseRevisionId: revisionId, edits: [{ hashline: thirdHashline, newText: "THIRD" }] },
					undefined,
					undefined,
					{ cwd: dir },
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				sawRefresh = /needs_refresh/.test(message);
			}
			assert.equal(sawRefresh, true);
			logPass("external mutation correctly returned needs_refresh");
		} catch (error) {
			failures++;
			logFail("external change should request refresh", error);
		}

		logHeader("Summary");
		if (failures === 0) {
			console.log("PASS all scenarios");
		} else {
			console.log(`FAIL ${failures} scenario(s)`);
			process.exitCode = 1;
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
