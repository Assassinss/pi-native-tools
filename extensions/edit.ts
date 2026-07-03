import {
  createEditToolDefinition,
  type EditToolDetails,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
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
  getDocumentSnapshot,
  getDocumentLineSnapshot,
  rememberDocumentSnapshot,
} from "./shared.ts";


export const editIo = {
  readFile: (path: string) => readFile(path),
  writeFile: (path: string, content: string) => fsWriteFile(path, content, "utf-8"),
};
import { invalidateFsScanCache } from "./omp-native.ts";

function editError(
  code: string,
  message: string,
  hint?: string,
  details?: Record<string, unknown>,
): Error {
  return toolError({ tool: "edit", code, message, hint, details });
}

const hashlineEditSchema = Type.Object(
  {
    hashline: Type.String({
      description:
        "Hashline anchor in format 'LINE:HEX'. Verifies the line at LINE still has the expected hash before applying. Example: '42:a1b2c3d4'",
    }),
    newText: Type.String({
      description: "Replacement text for this targeted edit.",
    }),
    wholeLine: Type.Optional(
      Type.Boolean({
        description:
          "When true, replace the anchored line. When false, insert newText after the anchored line. Default: true.",
      }),
    ),
  },
  { additionalProperties: false },
);

const editSchema = Type.Object(
  {
    path: Type.String({
      description: "Path to the file to edit (relative or absolute)",
    }),
    baseRevisionId: Type.Optional(
      Type.String({
        description:
          "Revision id returned by read(details.revisionId). Lets edit safely rebase stale hashlines from the same tool session.",
      }),
    ),
    edits: Type.Array(hashlineEditSchema, {
      minItems: 1,
      description:
        "One or more hashline-anchored edits. Each entry must have a hashline (LINE:HASH) and newText. Each edit is matched against the original file, not incrementally.",
    }),
    generateDiff: Type.Optional(
      Type.Boolean({
        description:
          "When false, skip generating the diff in details. Default: true.",
      }),
    ),
  },
  { additionalProperties: false },
);

export function parseHashline(
  hashline: string,
): { line: number; hash: string } | null {
  const match = hashline.match(
    new RegExp(`^(\\d+):([a-f0-9]{${HASH_SHORT_LEN}})$`, "i"),
  );
  if (!match) return null;
  return { line: parseInt(match[1], 10), hash: match[2].toLowerCase() };
}

export function verifyHashline(
  lineContent: string,
  expectedHash: string,
): boolean {
  return shortHash(lineContent).toLowerCase() === expectedHash.toLowerCase();
}

const EDIT_CONTEXT_LINES = 4; // ponytail: 4 context lines, tune if diffs need more/less context

export function generateStructuredPatch(
  filePath: string,
  oldContent: string,
  newContent: string,
  contextLines = EDIT_CONTEXT_LINES,
): StructuredPatch {
  return Diff.structuredPatch(
    filePath,
    filePath,
    oldContent,
    newContent,
    undefined,
    undefined,
    {
      context: contextLines,
    },
  )!;
}

export function formatStructuredPatch(patch: StructuredPatch): string {
  return Diff.formatPatch(patch, Diff.FILE_HEADERS_ONLY);
}

export function generateDiffStringFromPatch(patch: StructuredPatch): {
  diff: string;
  firstChangedLine?: number;
} {
  const output: string[] = [];
  const maxLineNum = Math.max(
    1,
    ...patch.hunks.flatMap((hunk) => [
      hunk.oldStart + Math.max(hunk.oldLines - 1, 0),
      hunk.newStart + Math.max(hunk.newLines - 1, 0),
    ]),
  );
  const lineNumWidth = String(maxLineNum).length;
  let firstChangedLine: number | undefined;
  let previousOldEnd = 0;

  for (const hunk of patch.hunks) {
    if (
      (previousOldEnd === 0 && hunk.oldStart > 1) ||
      (previousOldEnd > 0 && hunk.oldStart > previousOldEnd + 1)
    ) {
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
        output.push(
          `+${String(newLineNum).padStart(lineNumWidth, " ")} ${text}`,
        );
        newLineNum++;
        continue;
      }
      if (marker === "-") {
        if (firstChangedLine === undefined) firstChangedLine = newLineNum;
        output.push(
          `-${String(oldLineNum).padStart(lineNumWidth, " ")} ${text}`,
        );
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

type VerifiedHashlineEdit = {
  line: number;
  lineIndex: number;
  newText: string;
  wholeLine: boolean;
};

type HashlineEdit = {
  hashline: string;
  newText: string;
  wholeLine?: boolean;
};

type EditExecutionContext = {
  absolutePath: string;
  baseRevisionId?: string;
  currentRevisionId?: string;
  rebaseState?: "exact" | "rebased";
};

type ChangedRange = {
  start: number;
  end: number;
  hashlines: string[];
  truncated?: boolean;
};

const MAX_CHANGED_RANGES = 3;
const MAX_HASHLINES_PER_RANGE = 12;

function formatChangedRanges(changedRanges: ChangedRange[]): string {
  if (changedRanges.length === 0) return "";
  return changedRanges
    .map((range) => [
      `[changed lines ${range.start}-${range.end}${range.truncated ? " | truncated" : ""}]`,
      ...range.hashlines,
    ].join("\n"))
    .join("\n\n");
}

function formatHashline(line: string, lineNumber: number): string {
  return `${lineNumber}:${shortHash(line)}|${line}`;
}

export function collectChangedRanges(
  oldContent: string,
  newContent: string,
  contextLines = 2,
): ChangedRange[] {
  const patch = generateStructuredPatch("file", oldContent, newContent, contextLines);
  const { lines: newBaseLines, endsWithNewline } = splitContentLines(newContent);
  const newLines = endsWithNewline ? newBaseLines.concat("") : newBaseLines;
  return patch.hunks.slice(0, MAX_CHANGED_RANGES).map((hunk) => {
    const start = Math.max(1, hunk.newStart - contextLines);
    const hunkLength = Math.max(hunk.newLines, 1);
    const end = Math.min(newLines.length, hunk.newStart + hunkLength + contextLines - 1);
    const allHashlines = newLines.slice(start - 1, end).map((line, index) => formatHashline(line, start + index));
    return {
      start,
      end,
      hashlines: allHashlines.slice(0, MAX_HASHLINES_PER_RANGE),
      truncated: allHashlines.length > MAX_HASHLINES_PER_RANGE || patch.hunks.length > MAX_CHANGED_RANGES,
    };
  });
}

function findRebasedLineIndex(
  baseLine: string,
  currentContent: string,
  parsed: { line: number; hash: string },
  before?: string,
  after?: string,
): number | null {
  if (!verifyHashline(baseLine, parsed.hash)) return null;

  const { lines: currentBaseLines, endsWithNewline: currentEndsWithNewline } = splitContentLines(currentContent);
  const currentLines = currentEndsWithNewline ? currentBaseLines.concat("") : currentBaseLines;
  const exactMatches: number[] = [];
  for (let i = 0; i < currentLines.length; i++) {
    if (currentLines[i] === baseLine) exactMatches.push(i);
  }
  if (exactMatches.length === 0) return null;
  if (exactMatches.length === 1) return exactMatches[0]!;

  const contextualMatches = exactMatches.filter((index) => {
    if (before !== undefined && currentLines[index - 1] !== before) return false;
    if (after !== undefined && currentLines[index + 1] !== after) return false;
    return true;
  });
  if (contextualMatches.length === 1) return contextualMatches[0]!;
  return null;
}

function rebaseHashlineEdits(
  currentContent: string,
  edits: HashlineEdit[],
  filePath: string,
  context: EditExecutionContext,
): { content: string; rebaseState: EditExecutionContext["rebaseState"] } {
  if (!context.baseRevisionId || context.baseRevisionId === context.currentRevisionId) {
    return { content: applyHashlineEdits(currentContent, edits, filePath), rebaseState: "exact" };
  }
  const baseContent = getDocumentSnapshot(context.absolutePath, context.baseRevisionId);

  const rebasedEdits = edits.map((edit) => {
    const parsed = parseHashline(edit.hashline);
    if (!parsed) return edit;
    let rebasedLineIndex: number | null = null;
    if (baseContent) {
      const { lines: baseBaseLines, endsWithNewline: baseEndsWithNewline } = splitContentLines(baseContent);
      const baseLines = baseEndsWithNewline ? baseBaseLines.concat("") : baseBaseLines;
      const baseLineIndex = parsed.line - 1;
      const baseLine = baseLines[baseLineIndex];
      const before = baseLineIndex > 0 ? baseLines[baseLineIndex - 1] : undefined;
      const after = baseLineIndex + 1 < baseLines.length ? baseLines[baseLineIndex + 1] : undefined;
      if (baseLine !== undefined) rebasedLineIndex = findRebasedLineIndex(baseLine, currentContent, parsed, before, after);
    } else {
      const baseLine = getDocumentLineSnapshot(context.absolutePath, context.baseRevisionId!, parsed.line);
      const before = getDocumentLineSnapshot(context.absolutePath, context.baseRevisionId!, parsed.line - 1);
      const after = getDocumentLineSnapshot(context.absolutePath, context.baseRevisionId!, parsed.line + 1);
      if (baseLine !== undefined) rebasedLineIndex = findRebasedLineIndex(baseLine, currentContent, parsed, before, after);
    }
    if (rebasedLineIndex === null) {
      throw editError(
        "needs_refresh",
        `Edit failed: could not safely rebase hashline ${edit.hashline} in ${filePath}.`,
        "Read the file again with withHashlines=true and retry using the new revisionId and hashlines.",
        { path: filePath, hashline: edit.hashline, baseRevisionId: context.baseRevisionId, currentRevisionId: context.currentRevisionId },
      );
    }
    const currentLines = splitContentLines(currentContent);
    const linePool = currentLines.endsWithNewline ? currentLines.lines.concat("") : currentLines.lines;
    return {
      ...edit,
      hashline: `${rebasedLineIndex + 1}:${shortHash(linePool[rebasedLineIndex] ?? "")}`,
    };
  });

  return { content: applyHashlineEdits(currentContent, rebasedEdits, filePath), rebaseState: "rebased" };
}

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
        {
          hashline: edit.hashline,
          line,
          totalLines: originalLines.length,
          path: filePath,
        },
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
    const replacementLines = replacement.endsWithNewline
      ? [...replacement.lines, ""]
      : replacement.lines;
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
  baseRevisionId?: string;
  edits: Array<{ newText: string; hashline: string; wholeLine?: boolean }>;
}): {
  path: string;
  baseRevisionId?: string;
  edits: Array<{ hashline: string; newText: string; wholeLine?: boolean }>;
} {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw editError(
      "invalid_input",
      "Edit tool input is invalid. edits must contain at least one replacement.",
      "Pass edits as a non-empty array of hashline+newText entries.",
    );
  }

  for (const edit of input.edits) {
    if (!edit.hashline) {
      throw editError(
        "missing_hashline",
        "Edit failed: each edit must have a hashline (LINE:HASH format) for position-verified replacement.",
        "Use read(withHashlines=true) to capture fresh hashline data, then pass hashline+newText.",
      );
    }
  }

  return {
    path: input.path,
    baseRevisionId: input.baseRevisionId,
    edits: input.edits.map((e) => ({
      hashline: e.hashline,
      newText: e.newText,
      wholeLine: e.wholeLine,
    })),
  };
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

function recordNoopEdit(
  path: string,
  inputHash: string,
): { count: number; escalate: boolean } {
  const previous = noopEditCounts.get(path);
  const count = previous?.inputHash === inputHash ? previous.count + 1 : 1;
  noopEditCounts.set(path, { inputHash, count });
  return { count, escalate: count >= NOOP_HARD_LIMIT };
}

function clearNoopEdit(path: string): void {
  noopEditCounts.delete(path);
}

async function verifyEditWrite(
  absolutePath: string,
  path: string,
  expectedContent: string,
): Promise<void> {
  let writtenContent: string;
  try {
    writtenContent = (await editIo.readFile(absolutePath)).toString("utf-8");
  } catch (err: any) {
    throw editError(
      "verification_failed",
      `Edit applied to ${path} but failed to re-read the file: ${err.message}`,
      "Re-read the file and retry if the filesystem is unstable.",
      { path },
    );
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
      "Edit a file using hashline-anchored edits. Each edit entry uses hashline+newText for position-verified replacement anchored by LINE:SHORT_HASH.",
    promptSnippet:
      "Make precise file edits with hashline-anchored changes, including multiple disjoint edits in one call",
    promptGuidelines: [
      "Use read(withHashlines=true) first to capture LINE:HASH prefixes and keep details.revisionId for follow-up edits.",
      "Pass baseRevisionId from the latest read or edit result so stale hashlines can be safely rebased within the same tool session.",
      "After a successful edit, prefer reusing the returned changedRanges hashlines for nearby follow-up edits instead of reading the file again.",
      "Hashline replaces the entire line by default; use wholeLine:false to insert newText after the anchored line instead.",
      "Each edits[] entry is matched against the original file independently, not after earlier edits are applied.",
      "If edit returns needs_refresh, issue a new read(withHashlines=true) for the relevant region before retrying.",
    ],
    parameters: editSchema,
    renderShell: builtInEdit.renderShell,
    renderCall: builtInEdit.renderCall,
    renderResult: builtInEdit.renderResult,
    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd ?? process.cwd();
      const preparedInput = input;
      const { path, baseRevisionId, edits: hashlineEdits } = validateEditInput(
        preparedInput as any,
      );
      const generateDiff = (preparedInput as any).generateDiff !== false;
      const absolutePath = normalizePath(path, cwd);
      const inputHash = fullHash(JSON.stringify(preparedInput));

      return withFileMutationQueue(absolutePath, async () => {
        throwIfAborted(signal);
        let content: string;
        try {
          content = (await editIo.readFile(absolutePath)).toString("utf-8");
        } catch (err: any) {
          throwIfAborted(signal);
          if (err.code === "ENOENT") {
            throw editError(
              "file_not_found",
              `File not found: ${path}. Use write to create new files.`,
              "Create the file with write or check the path.",
              { path },
            );
          }
          if (err.code === "EACCES") {
            throw editError(
              "permission_denied",
              `Permission denied: ${path}`,
              "Choose a writable path or adjust permissions.",
              { path },
            );
          }
          throw editError(
            "read_failed",
            `Cannot access file: ${path}. Error: ${err.message}`,
            undefined,
            { path },
          );
        }
        throwIfAborted(signal);

        const currentRevisionId = rememberDocumentSnapshot(absolutePath, content);
        const editContext: EditExecutionContext = {
          absolutePath,
          baseRevisionId,
          currentRevisionId,
          rebaseState: "exact",
        };
        let newContent = content;
        if (hashlineEdits.length > 0) {
          const rebased = rebaseHashlineEdits(newContent, hashlineEdits, path, editContext);
          newContent = rebased.content;
          editContext.rebaseState = rebased.rebaseState;
        }
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
          await editIo.writeFile(absolutePath, newContent);
        } catch (err: any) {
          throwIfAborted(signal);
          if (err.code === "EACCES") {
            throw editError(
              "permission_denied_write",
              `Permission denied writing: ${path}`,
              "Choose a writable path or adjust permissions.",
              { path },
            );
          }
          if (err.code === "ENOSPC") {
            throw editError(
              "disk_full",
              `Disk full: cannot write to ${path}`,
              "Free disk space and retry the edit.",
              { path },
            );
          }
          throw editError(
            "write_failed",
            `Failed to write ${path}: ${err.message}`,
            undefined,
            { path },
          );
        }
        await verifyEditWrite(absolutePath, path, newContent);
        const revisionId = rememberDocumentSnapshot(absolutePath, newContent);
        clearNoopEdit(absolutePath);
        invalidateScanCache(absolutePath);

        const editCount = hashlineEdits.length;
        const changedRanges = collectChangedRanges(content, newContent);
        const details: EditToolDetails & {
          revisionId?: string;
          changedRanges?: ChangedRange[];
          rebaseState?: EditExecutionContext["rebaseState"];
        } = {
          revisionId,
          changedRanges,
          rebaseState: editContext.rebaseState,
        };
        if (generateDiff) {
          const patch = generateStructuredPatch(
            basename(absolutePath),
            content,
            newContent,
          );
          const diffResult = generateDiffStringFromPatch(patch);
          details.diff = diffResult.diff;
          details.patch = formatStructuredPatch(patch);
          details.firstChangedLine = diffResult.firstChangedLine;
        }
        return {
          content: [
            {
              type: "text",
              text: `Successfully applied ${editCount} edit(s) to ${path}.${editContext.rebaseState === "rebased" ? " Reused stale hashlines via automatic rebase." : ""}\nrevisionId: ${revisionId}${changedRanges.length > 0 ? `\n\n${formatChangedRanges(changedRanges)}` : ""}`,
            },
          ],
          details,
        };
      });
    },
  });
}
