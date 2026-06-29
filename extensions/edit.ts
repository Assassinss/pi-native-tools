import { createEditToolDefinition, type EditToolDetails, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Diff from "diff";
import type { StructuredPatch } from "diff";
import { Type } from "typebox";
import {
	HASH_SHORT_LEN,
	basename,
	fsWriteFile,
	fullHash,
	joinContentLines,
	normalizePath,
	readFile,
	shortHash,
	splitContentLines,
	throwIfAborted,
	withFileMutationQueue,
	dirname,
	toolError,
} from "./shared.ts";
import { invalidateFsScanCache } from "./omp-native.ts";

function editError(code: string, message: string, hint?: string, details?: Record<string, unknown>): Error {
	return toolError({ tool: "edit", code, message, hint, details });
}

const textEditSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text to replace. Must be unique in the file. Use this for direct text replacement when you already know the current content.",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
	},
	{ additionalProperties: false },
);

const hashlineEditSchema = Type.Object(
	{
		hashline: Type.String({
			description:
				"Hashline anchor in format 'LINE:HEX'. Verifies the line at LINE still has the expected hash before applying. Example: '42:a1b2c3d4'",
		}),
		newText: Type.String({ description: "Replacement text for this targeted edit." }),
		wholeLine: Type.Optional(
			Type.Boolean({
				description:
					"When true, replace the anchored line. When false, insert newText after the anchored line. Default: true.",
			}),
		),
	},
	{ additionalProperties: false },
);

const replaceEditSchema = Type.Union([textEditSchema, hashlineEditSchema]);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceEditSchema, {
			minItems: 1,
			description:
				"One or more targeted replacements. Each entry must be either oldText+newText or hashline+newText. Each edit is matched against the original file, not incrementally.",
		}),
		generateDiff: Type.Optional(
			Type.Boolean({
				description: "When false, skip generating the diff in details. Default: true.",
			}),
		),
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

function resolveUniqueMatch(content: string, candidate: string, newText: string, filePath: string): ResolvedTextEdit | null {
	const start = content.indexOf(candidate);
	if (start === -1) return null;
	if (content.indexOf(candidate, start + 1) !== -1) {
		throw editError(
			"old_text_not_unique",
			`Edit failed: oldText appears multiple times in ${filePath}. Provide more context to make it unique.`,
			"Use a longer oldText snippet so the match is unique within the file.",
			{ path: filePath },
		);
	}
	return { start, end: start + candidate.length, newText };
}

function resolveTextEdit(content: string, oldText: string, newText: string, filePath: string): ResolvedTextEdit {
	const candidates = [oldText];
	const trimmedTrailingNewline = oldText.endsWith("\n") ? oldText.slice(0, -1) : oldText;
	if (trimmedTrailingNewline !== oldText) candidates.push(trimmedTrailingNewline);
	if (content.includes("\r\n") && oldText.includes("\n") && !oldText.includes("\r\n")) {
		const crlfOldText = oldText.replace(/\n/g, "\r\n");
		candidates.push(crlfOldText);
		if (trimmedTrailingNewline !== oldText) {
			const trimmedCrlfOldText = trimmedTrailingNewline.replace(/\n/g, "\r\n");
			if (trimmedCrlfOldText !== crlfOldText) candidates.push(trimmedCrlfOldText);
		}
	}

	for (const candidate of candidates) {
		const resolved = resolveUniqueMatch(content, candidate, newText, filePath);
		if (resolved) return resolved;
	}

	throw editError(
		"old_text_not_found",
		`Edit failed: oldText not found in ${filePath}. The text to replace must match exactly, including whitespace.`,
		"Read the file again and copy the exact current text, including whitespace and line endings.",
		{ path: filePath },
	);
}

export function applyTextEdits(content: string, edits: Array<{ oldText: string; newText: string }>, filePath: string): string {
	const resolved = edits
		.map((edit) => resolveTextEdit(content, edit.oldText, edit.newText, filePath))
		.sort((a, b) => a.start - b.start);

	for (let i = 1; i < resolved.length; i++) {
		if (resolved[i - 1]!.end > resolved[i]!.start) {
			throw editError(
				"overlapping_edits",
				`Edit failed: edits overlap in ${filePath}. Merge nearby changes into one edit.`,
				"Combine overlapping edits into a single replacement matched against the original file.",
				{ path: filePath },
			);
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
	// ponytail: avoid spread copy when endsWithNewline is false
	const originalLines = endsWithNewline ? baseLines.concat("") : baseLines;
	const verified: VerifiedHashlineEdit[] = [];
	const targetedLines = new Set<number>();

	for (const edit of edits) {
		const parsed = parseHashline(edit.hashline);
		if (!parsed) {
			throw editError(
				"invalid_hashline_format",
				`Edit failed: invalid hashline format "${edit.hashline}". Expected format: LINE:${"a".repeat(HASH_SHORT_LEN)}`,
				"Capture fresh hashlines with read(withHashlines=true) and pass the LINE:HASH prefix unchanged.",
				{ hashline: edit.hashline, path: filePath },
			);
		}
		const { line, hash } = parsed;
		const lineIndex = line - 1;
		if (lineIndex < 0 || lineIndex >= originalLines.length) {
			throw editError(
				"hashline_out_of_range",
				`Edit failed: hashline ${edit.hashline} references line ${line}, but file ${filePath} has only ${originalLines.length} lines. The file may have changed since the hashline was captured.`,
				"Read the file again with withHashlines=true before retrying the edit.",
				{ hashline: edit.hashline, line, totalLines: originalLines.length, path: filePath },
			);
		}
		if (targetedLines.has(lineIndex)) {
			throw editError(
				"duplicate_hashline_target",
				`Edit failed: hashline ${edit.hashline} targets line ${line}, but another edit already targets this line. Merge edits targeting the same line.`,
				"Merge changes for the same anchored line into one edit entry.",
				{ hashline: edit.hashline, line, path: filePath },
			);
		}
		if (!verifyHashline(originalLines[lineIndex], hash)) {
			const actualHash = shortHash(originalLines[lineIndex]);
			throw editError(
				"hashline_mismatch",
				`Edit failed: hashline mismatch at line ${line}. Expected hash: ${hash}, actual: ${actualHash}.\nContent at line ${line}: ${originalLines[lineIndex]}\nThe file may have changed since the hashline was captured. Use read(withHashlines=true) to get fresh hashline data.`,
				"Refresh the file with read(withHashlines=true) and retry using the new hashline.",
				{ expectedHash: hash, actualHash, line, path: filePath },
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
		throw editError(
			"invalid_input",
			"Edit tool input is invalid. edits must contain at least one replacement.",
			"Pass edits as a non-empty array of oldText+newText or hashline+newText entries.",
		);
	}

	const textEdits: Array<{ oldText: string; newText: string }> = [];
	const hashlineEdits: Array<{ hashline: string; newText: string; wholeLine?: boolean }> = [];

	for (const edit of input.edits) {
		if (edit.hashline && edit.oldText) {
			throw editError(
				"conflicting_edit_modes",
				"Edit failed: edit cannot have both hashline and oldText. Use one or the other.",
				"Choose exactly one edit mode per entry: oldText+newText or hashline+newText.",
			);
		}
		if (!edit.hashline && !edit.oldText) {
			throw editError(
				"missing_edit_mode",
				"Edit failed: each edit must have either oldText (text match) or hashline (hashline anchor).",
				"Add oldText for text replacement or hashline for anchored replacement.",
			);
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

function invalidateScanCache(absolutePath: string): void {
	invalidateFsScanCache?.(absolutePath);
	invalidateFsScanCache?.(dirname(absolutePath));
}

type NoopEditState = {
	inputHash: string;
	count: number;
};

const noopEditCounts = new Map<string, NoopEditState>();
const NOOP_HARD_LIMIT = 3;

function recordNoopEdit(path: string, inputHash: string): { count: number; escalate: boolean } {
	const previous = noopEditCounts.get(path);
	const count = previous?.inputHash === inputHash ? previous.count + 1 : 1;
	noopEditCounts.set(path, { inputHash, count });
	return { count, escalate: count >= NOOP_HARD_LIMIT };
}

function clearNoopEdit(path: string): void {
	noopEditCounts.delete(path);
}

async function verifyEditWrite(absolutePath: string, path: string, expectedContent: string): Promise<void> {
	let writtenContent: string;
	try {
		writtenContent = (await readFile(absolutePath)).toString("utf-8");
	} catch (err: any) {
		throw editError("verification_failed", `Edit applied to ${path} but failed to re-read the file: ${err.message}`, "Re-read the file and retry if the filesystem is unstable.", { path });
	}
	if (writtenContent !== expectedContent) {
		throw editError(
			"verification_failed",
			`Edit write verification failed for ${path}: disk content differs from the requested update.`,
			"Re-read the file before retrying. Another process may have modified it.",
			{ path },
		);
	}
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
			"Use edit for precise changes to an existing file. Each edits[].oldText or edits[].hashline is matched against the original file, not after earlier edits are applied.",
			"If the user gave a known unique snippet to replace, call edit directly with oldText+newText; do not read first just to prepare the edit.",
			"Use read(withHashlines=true) first only for line-specific or safety-critical anchored edits, then pass hashline+newText.",
			"When changing multiple separate locations, use one edit call with multiple entries in edits[].",
		],
		parameters: editSchema,
		renderShell: builtInEdit.renderShell,
		renderCall: builtInEdit.renderCall,
		renderResult: builtInEdit.renderResult,
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input, signal, _onUpdate, ctx) {
			const cwd = ctx?.cwd ?? process.cwd();
			const preparedInput = prepareEditArguments(input);
			const { path, textEdits, hashlineEdits } = validateEditInput(preparedInput as any);
			const generateDiff = (preparedInput as any).generateDiff !== false;
			const absolutePath = normalizePath(path, cwd);
			const inputHash = fullHash(JSON.stringify(preparedInput));

			return withFileMutationQueue(absolutePath, async () => {
				throwIfAborted(signal);
				let content: string;
				try {
					content = (await readFile(absolutePath)).toString("utf-8");
				} catch (err: any) {
					throwIfAborted(signal);
					if (err.code === "ENOENT") {
						throw editError("file_not_found", `File not found: ${path}. Use write to create new files.`, "Create the file with write or check the path.", { path });
					}
					if (err.code === "EACCES") {
						throw editError("permission_denied", `Permission denied: ${path}`, "Choose a writable path or adjust permissions.", { path });
					}
					throw editError("read_failed", `Cannot access file: ${path}. Error: ${err.message}`, undefined, { path });
				}
				throwIfAborted(signal);

				let newContent = content;
				if (textEdits.length > 0) newContent = applyTextEdits(newContent, textEdits, path);
				throwIfAborted(signal);
				if (hashlineEdits.length > 0) newContent = applyHashlineEdits(newContent, hashlineEdits, path);
				throwIfAborted(signal);

				if (newContent === content) {
					const noop = recordNoopEdit(absolutePath, inputHash);
					throw editError(
						noop.escalate ? "noop_edit_loop" : "noop_edit",
						noop.escalate
							? `Edit failed: identical no-op edit repeated ${noop.count} times for ${path}. Re-read the file and issue a different edit.`
							: `Edit made no changes to ${path}. Re-read the file and issue a different edit.`,
						noop.escalate
							? "This exact edit payload keeps producing no changes. Read the file again before retrying."
							: "Read the file again and change the edit payload before retrying.",
						{ path, repeatCount: noop.count },
					);
				}

				try {
					await fsWriteFile(absolutePath, newContent, "utf-8");
				} catch (err: any) {
					throwIfAborted(signal);
					if (err.code === "EACCES") {
						throw editError("permission_denied_write", `Permission denied writing: ${path}`, "Choose a writable path or adjust permissions.", { path });
					}
					if (err.code === "ENOSPC") {
						throw editError("disk_full", `Disk full: cannot write to ${path}`, "Free disk space and retry the edit.", { path });
					}
					throw editError("write_failed", `Failed to write ${path}: ${err.message}`, undefined, { path });
				}
				await verifyEditWrite(absolutePath, path, newContent);
				clearNoopEdit(absolutePath);
				invalidateScanCache(absolutePath);

				const editCount = textEdits.length + hashlineEdits.length;
				const details: EditToolDetails = {};
				if (generateDiff) {
					const patch = generateStructuredPatch(basename(absolutePath), content, newContent);
					const diffResult = generateDiffStringFromPatch(patch);
					details.diff = diffResult.diff;
					details.patch = formatStructuredPatch(patch);
					details.firstChangedLine = diffResult.firstChangedLine;
				}
				return {
					content: [{ type: "text", text: `Successfully applied ${editCount} edit(s) to ${path}.` }],
					details,
				};
			});
		},
	});
}
