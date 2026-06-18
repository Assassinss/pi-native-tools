import { createEditToolDefinition, type EditToolDetails, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Diff from "diff";
import { Type } from "typebox";
import {
	HASH_SHORT_LEN,
	access,
	basename,
	constants,
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
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;
	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();

		if (part.added || part.removed) {
			if (firstChangedLine === undefined) firstChangedLine = newLineNum;
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;
					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;
				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}
			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
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

export function applyTextEdits(content: string, edits: Array<{ oldText: string; newText: string }>, filePath: string): string { // ponytail: O(n) scan per edit, n=file lines; O(n*m) worst-case if edits share prefix
	let result = content;
	for (const edit of edits) {
		const idx = result.indexOf(edit.oldText);
		if (idx === -1) {
			const normalizedOld = edit.oldText.endsWith("\n") ? edit.oldText.slice(0, -1) : edit.oldText;
			const idx2 = result.indexOf(normalizedOld);
			if (idx2 === -1) {
				throw new Error(
					`Edit failed: oldText not found in ${filePath}. The text to replace must match exactly, including whitespace. Occurrence count: ${result.split(edit.oldText).length - 1}`,
				);
			}
			result = result.slice(0, idx2) + edit.newText + result.slice(idx2 + normalizedOld.length);
		} else {
			const secondIdx = result.indexOf(edit.oldText, idx + 1);
			if (secondIdx !== -1) {
				throw new Error(`Edit failed: oldText appears multiple times in ${filePath}. Provide more context to make it unique.`);
			}
			result = result.slice(0, idx) + edit.newText + result.slice(idx + edit.oldText.length);
		}
	}
	return result;
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
				try {
					await access(absolutePath, constants.R_OK | constants.W_OK);
				} catch (err: any) {
					throwIfAborted(signal);
					if (err.code === "ENOENT") throw new Error(`File not found: ${path}. Use write to create new files.`);
					if (err.code === "EACCES") throw new Error(`Permission denied: ${path}`);
					throw new Error(`Cannot access file: ${path}. Error: ${err.message}`);
				}

				throwIfAborted(signal);
				const content = (await readFile(absolutePath)).toString("utf-8");
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

				const diffResult = generateDiffString(content, newContent);
				const patch = generatePatch(basename(absolutePath), content, newContent);
				const editCount = textEdits.length + hashlineEdits.length;
				return {
					content: [{ type: "text", text: `Successfully applied ${editCount} edit(s) to ${path}.` }],
					details: {
						diff: diffResult.diff,
						patch,
						firstChangedLine: diffResult.firstChangedLine,
					} as EditToolDetails,
				};
			});
		},
	});
}
