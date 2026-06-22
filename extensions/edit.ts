import { createEditToolDefinition, type EditToolDetails, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Diff from "diff";
import type { StructuredPatch } from "diff";
import { Type } from "typebox";
import {
	HASH_SHORT_LEN,
	basename,
	fsWriteFile,
	joinContentLines,
	normalizePath,
	readFile,
	shortHash,
	splitContentLines,
	throwIfAborted,
	withFileMutationQueue,
} from "./shared.ts";

const replaceEditSchema = Type.Object(
	{
		oldText: Type.Optional(
			Type.String({
				description:
					"Exact text to replace. Must be unique in the file. Mutually exclusive with hashline.",
			}),
		),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
		hashline: Type.Optional(
			Type.String({
				description:
					"Hashline anchor in format 'LINE:HEX'. Verifies the line at LINE still has the expected hash before applying. Mutually exclusive with oldText. Example: '42:a1b2c3d4'",
			}),
		),
		wholeLine: Type.Optional(
			Type.Boolean({
				description:
					"When true with hashline, the entire line content is replaced by newText. When false with hashline, newText is inserted after the anchored line. Default: true",
			}),
		),
	},
	{ additionalProperties: false },
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			description:
				"One or more targeted replacements. Supports text-based (oldText) or hashline-anchored edits. Each edit is matched against the original file, not incrementally.",
		}),
	},
	{ additionalProperties: false },
);

export function parseHashline(hashline: string): { line: number; hash: string } | null {
	const match = hashline.match(new RegExp(`^(\\d+):([a-f0-9]{${HASH_SHORT_LEN}})$`, "i"));
	if (!match) return null;
	return { line: parseInt(match[1], 10), hash: match[2].toLowerCase() };
}

export function verifyHashline(lineContent: string, expectedHash: string): boolean {
	return shortHash(lineContent).toLowerCase() === expectedHash.toLowerCase();
}

const EDIT_CONTEXT_LINES = 4; // ponytail: 4 context lines, tune if diffs need more/less context

export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = EDIT_CONTEXT_LINES,
): { diff: string; firstChangedLine?: number } {
	const patch = generateStructuredPatch("file", oldContent, newContent, contextLines);
	return generateDiffStringFromPatch(patch);
}

export function generatePatch(
	filePath: string,
	oldContent: string,
	newContent: string,
	contextLines = EDIT_CONTEXT_LINES,
): string {
	return Diff.createTwoFilesPatch(filePath, filePath, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

export function generateStructuredPatch(
	filePath: string,
	oldContent: string,
	newContent: string,
	contextLines = EDIT_CONTEXT_LINES,
): StructuredPatch {
	return Diff.structuredPatch(filePath, filePath, oldContent, newContent, undefined, undefined, {
		context: contextLines,
	})!;
}

export function formatStructuredPatch(patch: StructuredPatch): string {
	return Diff.formatPatch(patch, Diff.FILE_HEADERS_ONLY);
}

export function generateDiffStringFromPatch(patch: StructuredPatch): { diff: string; firstChangedLine?: number } {
	const output: string[] = [];
	const maxLineNum = Math.max(
		1,
		...patch.hunks.flatMap((hunk) => [hunk.oldStart + Math.max(hunk.oldLines - 1, 0), hunk.newStart + Math.max(hunk.newLines - 1, 0)]),
	);
	const lineNumWidth = String(maxLineNum).length;
	let firstChangedLine: number | undefined;
	let previousOldEnd = 0;

	for (const hunk of patch.hunks) {
		if ((previousOldEnd === 0 && hunk.oldStart > 1) || (previousOldEnd > 0 && hunk.oldStart > previousOldEnd + 1)) {
			output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
		}

		let oldLineNum = hunk.oldStart;
		let newLineNum = hunk.newStart;
		for (const line of hunk.lines) {
			if (line.startsWith("\\")) continue;
			const marker = line[0]!;
			const text = line.slice(1);
			if (marker === "+") {
				if (firstChangedLine === undefined) firstChangedLine = newLineNum;
				output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${text}`);
				newLineNum++;
				continue;
			}
			if (marker === "-") {
				if (firstChangedLine === undefined) firstChangedLine = newLineNum;
				output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${text}`);
				oldLineNum++;
				continue;
			}
			output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${text}`);
			oldLineNum++;
			newLineNum++;
		}
		previousOldEnd = Math.max(previousOldEnd, oldLineNum - 1);
	}

	return { diff: output.join("\n"), firstChangedLine };
}

type ResolvedTextEdit = {
	start: number;
	end: number;
	newText: string;
};

function resolveTextEdit(content: string, oldText: string, newText: string, filePath: string): ResolvedTextEdit {
	const exactStart = content.indexOf(oldText);
	if (exactStart !== -1) {
		if (content.indexOf(oldText, exactStart + 1) !== -1) {
			throw new Error(`Edit failed: oldText appears multiple times in ${filePath}. Provide more context to make it unique.`);
		}
		return { start: exactStart, end: exactStart + oldText.length, newText };
	}

	const normalizedOld = oldText.endsWith("\n") ? oldText.slice(0, -1) : oldText;
	const normalizedStart = content.indexOf(normalizedOld);
	if (normalizedStart === -1) {
		throw new Error(`Edit failed: oldText not found in ${filePath}. The text to replace must match exactly, including whitespace.`);
	}
	if (content.indexOf(normalizedOld, normalizedStart + 1) !== -1) {
		throw new Error(`Edit failed: oldText appears multiple times in ${filePath}. Provide more context to make it unique.`);
	}
	return { start: normalizedStart, end: normalizedStart + normalizedOld.length, newText };
}

export function applyTextEdits(content: string, edits: Array<{ oldText: string; newText: string }>, filePath: string): string {
	const resolved = edits
		.map((edit) => resolveTextEdit(content, edit.oldText, edit.newText, filePath))
		.sort((a, b) => a.start - b.start);

	for (let i = 1; i < resolved.length; i++) {
		if (resolved[i - 1]!.end > resolved[i]!.start) {
			throw new Error(`Edit failed: edits overlap in ${filePath}. Merge nearby changes into one edit.`);
		}
	}

	if (resolved.length === 1) {
		const edit = resolved[0]!;
		return content.slice(0, edit.start) + edit.newText + content.slice(edit.end);
	}

	const parts: string[] = [];
	let lastIndex = 0;
	for (const edit of resolved) {
		parts.push(content.slice(lastIndex, edit.start), edit.newText);
		lastIndex = edit.end;
	}
	parts.push(content.slice(lastIndex));
	return parts.join("");
}

type VerifiedHashlineEdit = {
	line: number;
	lineIndex: number;
	newText: string;
	wholeLine: boolean;
};

export function applyHashlineEdits(
	content: string,
	edits: Array<{ hashline: string; newText: string; wholeLine?: boolean }>,
	filePath: string,
): string {
	const { lines: baseLines, endsWithNewline } = splitContentLines(content);
	const originalLines = endsWithNewline ? [...baseLines, ""] : [...baseLines];
	const verified: VerifiedHashlineEdit[] = [];
	const targetedLines = new Set<number>();

	for (const edit of edits) {
		const parsed = parseHashline(edit.hashline);
		if (!parsed) {
			throw new Error(`Edit failed: invalid hashline format "${edit.hashline}". Expected format: LINE:${"a".repeat(HASH_SHORT_LEN)}`);
		}
		const { line, hash } = parsed;
		const lineIndex = line - 1;
		if (lineIndex < 0 || lineIndex >= originalLines.length) {
			throw new Error(
				`Edit failed: hashline ${edit.hashline} references line ${line}, but file ${filePath} has only ${originalLines.length} lines. The file may have changed since the hashline was captured.`,
			);
		}
		if (targetedLines.has(lineIndex)) {
			throw new Error(
				`Edit failed: hashline ${edit.hashline} targets line ${line}, but another edit already targets this line. Merge edits targeting the same line.`,
			);
		}
		if (!verifyHashline(originalLines[lineIndex], hash)) {
			const actualHash = shortHash(originalLines[lineIndex]);
			throw new Error(
				`Edit failed: hashline mismatch at line ${line}. Expected hash: ${hash}, actual: ${actualHash}.\nContent at line ${line}: ${originalLines[lineIndex]}\nThe file may have changed since the hashline was captured. Use read(withHashlines=true) to get fresh hashline data.`,
			);
		}
		verified.push({
			line,
			lineIndex,
			newText: edit.newText,
			wholeLine: edit.wholeLine !== false,
		});
		targetedLines.add(lineIndex);
	}

	const resultLines = [...originalLines];
	for (const edit of [...verified].sort((a, b) => b.lineIndex - a.lineIndex)) {
		const replacement = splitContentLines(edit.newText);
		const replacementLines = replacement.endsWithNewline ? [...replacement.lines, ""] : replacement.lines;
		if (edit.wholeLine) {
			resultLines.splice(edit.lineIndex, 1, ...replacementLines);
			continue;
		}
		resultLines.splice(edit.lineIndex + 1, 0, ...replacementLines);
	}

	return joinContentLines(resultLines, false);
}

export function validateEditInput(input: {
	path: string;
	edits: Array<{ oldText?: string; newText: string; hashline?: string; wholeLine?: boolean }>;
}): {
	path: string;
	textEdits: Array<{ oldText: string; newText: string }>;
	hashlineEdits: Array<{ hashline: string; newText: string; wholeLine?: boolean }>;
} {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}

	const textEdits: Array<{ oldText: string; newText: string }> = [];
	const hashlineEdits: Array<{ hashline: string; newText: string; wholeLine?: boolean }> = [];

	for (const edit of input.edits) {
		if (edit.hashline && edit.oldText) {
			throw new Error("Edit failed: edit cannot have both hashline and oldText. Use one or the other.");
		}
		if (!edit.hashline && !edit.oldText) {
			throw new Error("Edit failed: each edit must have either oldText (text match) or hashline (hashline anchor).");
		}
		if (edit.hashline) {
			hashlineEdits.push({ hashline: edit.hashline, newText: edit.newText, wholeLine: edit.wholeLine });
		} else {
			textEdits.push({ oldText: edit.oldText!, newText: edit.newText });
		}
	}

	return { path: input.path, textEdits, hashlineEdits };
}

export function prepareEditArguments(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object") return input as Record<string, unknown>;
	const args = input as Record<string, unknown>;

	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
		} catch {
			// ignore parse errors
		}
	}

	const legacy = args as Record<string, unknown> & { oldText?: unknown; newText?: unknown };
	if (typeof legacy.oldText === "string" && typeof legacy.newText === "string") {
		const edits = Array.isArray(args.edits) ? [...(args.edits as unknown[])] : [];
		edits.push({ oldText: legacy.oldText, newText: legacy.newText });
		const { oldText: _ot, newText: _nt, ...rest } = args;
		return { ...rest, edits };
	}

	return args;
}

export function registerEditTool(pi: ExtensionAPI): void {
	const builtInEdit = createEditToolDefinition(process.cwd());

	pi.registerTool({
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement OR hashline-anchored edits. Each edit entry supports two modes: (1) oldText+newText for exact match replacement (must be unique), or (2) hashline+newText for position-verified replacement anchored by LINE:SHORT_HASH.",
		promptSnippet:
			"Make precise file edits with exact text replacement or hashline-anchored changes, including multiple disjoint edits in one call",
		promptGuidelines: [
			"Use edit for precise changes. Each edits[].oldText or edits[].hashline is matched against the original file, not after earlier edits are applied.",
			"When changing multiple separate locations, use one edit call with multiple entries in edits[] instead of multiple edit calls.",
			"For hashline-anchored safety: use read(withHashlines=true) first to capture line hashes, then use hashline+newText to verify line positions.",
			"Keep edits[].oldText as small as possible while still being unique in the file.",
			"Do not emit overlapping or nested edits.",
		],
		parameters: editSchema,
		renderShell: builtInEdit.renderShell,
		renderCall: builtInEdit.renderCall,
		renderResult: builtInEdit.renderResult,
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			const cwd = ctx?.cwd ?? process.cwd();
			const { path, textEdits, hashlineEdits } = validateEditInput(input as any);
			const absolutePath = normalizePath(path, cwd);

			return withFileMutationQueue(absolutePath, async () => { // ponytail: global lock per-file, prevents concurrent writes; per-account locks if multi-user needed
				throwIfAborted(signal);
				let content: string;
				try {
					content = (await readFile(absolutePath)).toString("utf-8");
				} catch (err: any) {
					throwIfAborted(signal);
					if (err.code === "ENOENT") throw new Error(`File not found: ${path}. Use write to create new files.`);
					if (err.code === "EACCES") throw new Error(`Permission denied: ${path}`);
					throw new Error(`Cannot access file: ${path}. Error: ${err.message}`);
				}
				throwIfAborted(signal);

				let newContent = content;
				if (textEdits.length > 0) newContent = applyTextEdits(newContent, textEdits, path);
				throwIfAborted(signal);
				if (hashlineEdits.length > 0) newContent = applyHashlineEdits(newContent, hashlineEdits, path);
				throwIfAborted(signal);

				try {
					await fsWriteFile(absolutePath, newContent, "utf-8");
				} catch (err: any) {
					throwIfAborted(signal);
					if (err.code === "EACCES") throw new Error(`Permission denied writing: ${path}`);
					if (err.code === "ENOSPC") throw new Error(`Disk full: cannot write to ${path}`);
					throw new Error(`Failed to write ${path}: ${err.message}`);
				}

				const patch = generateStructuredPatch(basename(absolutePath), content, newContent);
				const diffResult = generateDiffStringFromPatch(patch);
				const editCount = textEdits.length + hashlineEdits.length;
				return {
					content: [{ type: "text", text: `Successfully applied ${editCount} edit(s) to ${path}.` }],
					details: {
						diff: diffResult.diff,
						patch: formatStructuredPatch(patch),
						firstChangedLine: diffResult.firstChangedLine,
					} as EditToolDetails,
				};
			});
		},
	});
}
