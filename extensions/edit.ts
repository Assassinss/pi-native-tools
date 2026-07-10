import { createEditToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  dirname,
  fsWriteFile,
  normalizePath,
  readFile,
  rememberDocumentSnapshot,
  throwIfAborted,
  toolError,
  withFileMutationQueue,
} from "./shared.ts";
import { invalidateFsScanCache } from "./omp-native.ts";

type EditConflictReason = "not_found" | "ambiguous" | "stale_snapshot" | "overlap" | "no_change";

type EditResultDetails =
  | {
      status: "applied";
      appliedCount: number;
      newSnapshotId: string;
    }
  | {
      status: "conflict";
      reason: EditConflictReason;
      message: string;
      candidates?: Array<{ preview: string }>;
      latestSnapshotId?: string;
    };

type EditConflictResult = {
  content: Array<{ type: "text"; text: string }>;
  details: EditResultDetails;
};

const replaceEditSchema = Type.Object(
  {
    oldText: Type.String({ description: "Exact existing text to replace. Must be unique in the file and non-overlapping with other edits[].oldText." }),
    newText: Type.String({ description: "Replacement text for this targeted edit." }),
  },
  { additionalProperties: false },
);

const editSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
    snapshotId: Type.Optional(
      Type.String({ description: "Snapshot id returned by read(details.snapshotId). Strongly recommended; without it, stale edits cannot be detected." }),
    ),
    edits: Type.Optional(
      Type.Array(replaceEditSchema, {
        description: "One or more targeted replacements applied against the original file (not incrementally). Use this for multiple disjoint edits in one call instead of multiple edit calls. Each oldText must match exactly once and not overlap with other edits.",
      }),
    ),
    oldText: Type.Optional(
      Type.String({ description: "Exact existing text to replace (legacy single-edit). Prefer edits[] for batch edits." }),
    ),
    newText: Type.Optional(
      Type.String({ description: "Replacement text (legacy single-edit). Prefer edits[] for batch edits." }),
    ),
    replaceAll: Type.Optional(
      Type.Boolean({ description: "Replace every exact match. Default: false. Only used in legacy single-edit mode." }),
    ),
  },
  { additionalProperties: false },
);

type EditEntry = Type.Static<typeof replaceEditSchema>;
type ResolvedEdit = EditEntry & { index: number };

function editError(code: string, message: string, hint?: string, details?: Record<string, unknown>): Error {
  return toolError({ tool: "edit", code, message, hint, details });
}

function findMatchIndices(content: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const matches: number[] = [];
  let cursor = 0;
  while (cursor <= content.length) {
    const index = content.indexOf(needle, cursor);
    if (index === -1) break;
    matches.push(index);
    cursor = index + Math.max(needle.length, 1);
  }
  return matches;
}

function findCompatibleMatches(content: string, oldText: string): { oldText: string; matches: number[] } {
  const exact = findMatchIndices(content, oldText);
  if (exact.length > 0 || !oldText.includes("\n")) return { oldText, matches: exact };

  // Readable output and pasted text may normalize CRLF to LF; no other whitespace is relaxed.
  for (const candidate of [oldText.replace(/\r\n/g, "\n"), oldText.replace(/\r?\n/g, "\r\n")]) {
    if (candidate === oldText) continue;
    const matches = findMatchIndices(content, candidate);
    if (matches.length > 0) return { oldText: candidate, matches };
  }
  return { oldText, matches: [] };
}

function buildPreview(content: string, index: number, needle: string): string {
  const previewRadius = 30;
  const start = Math.max(0, index - previewRadius);
  const end = Math.min(content.length, index + needle.length + previewRadius);
  return content
    .slice(start, end)
    .replace(/\r/g, "")
    .replace(/\n/g, "\\n");
}

function buildConflict(
  reason: EditConflictReason,
  message: string,
  latestSnapshotId?: string,
  candidates?: Array<{ preview: string }>,
): EditConflictResult {
  const extras = [message, latestSnapshotId ? `latestSnapshotId: ${latestSnapshotId}` : "", candidates?.length ? `candidates: ${candidates.length}` : ""].filter(Boolean).join("; ");
  return {
    content: [{ type: "text", text: `Conflict: ${reason}. ${extras}` }],
    details: {
      status: "conflict",
      reason,
      message,
      ...(candidates && candidates.length > 0 ? { candidates } : {}),
      ...(latestSnapshotId ? { latestSnapshotId } : {}),
    },
  };
}

function buildAppliedContent(content: string, edits: ResolvedEdit[]): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    parts.push(content.slice(cursor, edit.index), edit.newText);
    cursor = edit.index + edit.oldText.length;
  }
  parts.push(content.slice(cursor));
  return parts.join("");
}

function buildAppliedResult(
  path: string,
  appliedCount: number,
  newSnapshotId: string,
): { content: Array<{ type: "text"; text: string }>; details: EditResultDetails } {
  return {
    content: [
      {
        type: "text",
        text: `Applied ${appliedCount} replacement${appliedCount === 1 ? "" : "s"} to ${path}.\nsnapshotId: ${newSnapshotId}\nUse this snapshotId for your next edit on this file — no need to re-read.`,
      },
    ],
    details: { status: "applied", appliedCount, newSnapshotId },
  };
}

function invalidateScanCache(absolutePath: string): void {
  invalidateFsScanCache(absolutePath);
  invalidateFsScanCache(dirname(absolutePath));
}

/**
 * Apply edits against original content.
 * When allowMultiple is false, each oldText must match exactly once and not overlap with other edits.
 * When allowMultiple is true, only one edit is expected; every occurrence is replaced.
 * Returns conflict result object directly (instead of throwing) so caller can handle it.
 */
function applyEdits(
  content: string,
  edits: EditEntry[],
  path: string,
  allowMultiple: boolean,
): { newContent: string; appliedCount: number } | { conflict: EditConflictResult } {
  if (allowMultiple) {
    // ReplaceAll mode: single edit, replace every occurrence
    const single = edits[0];
    if (single.oldText === single.newText) {
      return { conflict: buildConflict("no_change", `Edit made no changes to ${path}.`) };
    }
    const match = findCompatibleMatches(content, single.oldText);
    if (match.matches.length === 0) {
      return { conflict: buildConflict("not_found", `oldText was not found in ${path}. Re-read the current text and retry.`) };
    }
    const positions: ResolvedEdit[] = match.matches.map((index) => ({
      index,
      oldText: match.oldText,
      newText: single.newText,
    }));
    return { newContent: buildAppliedContent(content, positions), appliedCount: match.matches.length };
  }

  // Batch mode: each edit must match exactly once and not overlap
  if (edits.every((e) => e.oldText === e.newText)) {
    return { conflict: buildConflict("no_change", `Edit made no changes to ${path}.`) };
  }
  const positions: ResolvedEdit[] = [];
  for (const edit of edits) {
    const match = findCompatibleMatches(content, edit.oldText);
    const { matches } = match;
    if (matches.length === 0) {
      return {
        conflict: buildConflict(
          "not_found",
          `oldText was not found in ${path}: "${edit.oldText.slice(0, 80)}${edit.oldText.length > 80 ? "..." : ""}"`,
        ),
      };
    }
    if (matches.length > 1) {
      const candidates = matches.slice(0, 3).map((index) => ({
        preview: buildPreview(content, index, edit.oldText),
      }));
      const candidatePreviews = candidates.map((c) => c.preview).join(", ");
      return {
        conflict: buildConflict(
          "ambiguous",
          `oldText matched ${matches.length} locations in ${path}: [${candidatePreviews}]. Narrow the text and retry.`,
          undefined,
          candidates,
        ),
      };
    }
    positions.push({ index: matches[0], oldText: match.oldText, newText: edit.newText });
  }

  // Check for overlaps (positions are in discovery order, sort by index)
  positions.sort((a, b) => a.index - b.index);
  for (let i = 1; i < positions.length; i++) {
    const prevEnd = positions[i - 1].index + positions[i - 1].oldText.length;
    if (positions[i].index < prevEnd) {
      const a = positions[i - 1];
      const b = positions[i];
      return {
        conflict: buildConflict(
          "overlap",
          `Edits overlap in ${path}: "${a.oldText.slice(0, 40)}..." and "${b.oldText.slice(0, 40)}..." touch the same region. Merge them into one edit.`,
        ),
      };
    }
  }

  return { newContent: buildAppliedContent(content, positions), appliedCount: edits.length };
}

/** Normalize legacy oldText/newText + edits[] into a flat edits array. */
function normalizeEdits(params: {
  oldText?: string;
  newText?: string;
  replaceAll?: boolean;
  edits?: EditEntry[];
}): { edits: EditEntry[]; replaceAll: boolean } {
  const result: EditEntry[] = [];
  const hasBatchEdits = (params.edits?.length ?? 0) > 0;
  const hasLegacyOldText = params.oldText !== undefined;
  const hasLegacyNewText = params.newText !== undefined;

  if (hasBatchEdits && (hasLegacyOldText || hasLegacyNewText)) {
    throw editError(
      "invalid_input",
      "Edit failed: do not combine edits[] with oldText/newText.",
      "Use either edits[] for batch edits or oldText+newText for the legacy single-edit form.",
      {},
    );
  }

  if (hasLegacyOldText !== hasLegacyNewText) {
    throw editError(
      "invalid_input",
      "Edit failed: oldText and newText must be provided together.",
      "Pass both oldText and newText, or use edits[].",
      {},
    );
  }

  if (hasBatchEdits && params.replaceAll) {
    throw editError(
      "invalid_input",
      "Edit failed: replaceAll can only be used with oldText/newText.",
      "Use oldText+newText for replaceAll, or remove replaceAll when using edits[].",
      {},
    );
  }
  if (params.edits) {
    result.push(...params.edits);
  }

  if (params.oldText !== undefined && params.newText !== undefined) {
    result.push({ oldText: params.oldText, newText: params.newText });
  }

  if (result.length === 0) {
    throw editError(
      "invalid_input",
      "Edit failed: provide either edits[] or oldText+newText.",
      "Pass at least one replacement pair.",
      {},
    );
  }

  return { edits: result, replaceAll: params.replaceAll ?? false };
}

export async function executeEdit(
  path: string,
  snapshotId: string | undefined,
  edits: EditEntry[],
  replaceAll: boolean,
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<{ content: Array<{ type: string; text: string }>; details: EditResultDetails }> {
  for (const edit of edits) {
    if (edit.oldText.length === 0) {
      throw editError(
        "invalid_input",
        "Edit failed: oldText must be a non-empty string.",
        "Pass the exact existing text you want to replace.",
        { path },
      );
    }
  }

  const absolutePath = normalizePath(path, cwd);

  return withFileMutationQueue(absolutePath, async () => {
    let content: string;
    try {
      content = (await readFile(absolutePath)).toString("utf-8");
    } catch (err: unknown) {
      throwIfAborted(signal);
      const nodeErr = err as { code?: string; message?: string };
      if (nodeErr.code === "ENOENT") {
        throw editError("file_not_found", `File not found: ${path}. Use write to create new files.`, "Create the file with write or check the path.", { path });
      }
      if (nodeErr.code === "EACCES") {
        throw editError("permission_denied", `Permission denied: ${path}`, "Choose a writable path or adjust permissions.", { path });
      }
      throw editError("read_failed", `Cannot access file: ${path}. Error: ${nodeErr.message}`, undefined, { path });
    }

    const currentSnapshotId = rememberDocumentSnapshot(absolutePath, content);
    if (snapshotId && snapshotId !== currentSnapshotId) {
      return buildConflict(
        "stale_snapshot",
        `Snapshot ${snapshotId} is stale for ${path}. Re-read the file before retrying.`,
        currentSnapshotId,
      );
    }

    // Single unified path: applyEdits handles both batch and replaceAll modes
    const result = applyEdits(content, edits, path, replaceAll);
    if ("conflict" in result) {
      return result.conflict;
    }

    const { newContent, appliedCount } = result;
    if (newContent === content) {
      return buildConflict("no_change", `Edit made no changes to ${path}.`, currentSnapshotId);
    }

    await writeFile(absolutePath, path, newContent, signal);
    const newSnapshotId = rememberDocumentSnapshot(absolutePath, newContent);
    invalidateScanCache(absolutePath);

    return buildAppliedResult(path, appliedCount, newSnapshotId);
  });
}

async function writeFile(
  absolutePath: string,
  path: string,
  content: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    await fsWriteFile(absolutePath, content, "utf-8");
  } catch (err: unknown) {
    throwIfAborted(signal);
    const nodeErr = err as { code?: string; message?: string };
    if (nodeErr.code === "EACCES") {
      throw editError("permission_denied_write", `Permission denied writing: ${path}`, "Choose a writable path or adjust permissions.", { path });
    }
    if (nodeErr.code === "ENOSPC") {
      throw editError("disk_full", `Disk full: cannot write to ${path}`, "Free disk space and retry the edit.", { path });
    }
    throw editError("write_failed", `Failed to write ${path}: ${nodeErr.message}`, undefined, { path });
  }
}

export function registerEditTool(pi: ExtensionAPI): void {
  const builtInEdit = createEditToolDefinition(process.cwd());

  pi.registerTool({
    name: "edit",
    label: "edit",
    description: "Edit a file by replacing exact oldText with newText, ideally against a read snapshot so stale edits can be detected. Use edits[] for multiple disjoint replacements in one call.",
    promptSnippet: "Apply exact oldText/newText replacements with snapshot checks",
    promptGuidelines: [
      "Before the first edit of an existing file, read it and pass its latest snapshotId.",
      "After an edit, reuse the returned snapshotId; re-read only when context changed or a conflict occurs.",
      "Use unique oldText. For ambiguous matches, read a narrower region and retry with more surrounding text.",
      "Use edits[] for disjoint replacements; entries match the original snapshot and must not overlap.",
      "Use replaceAll only when every exact occurrence must change.",
    ],
    parameters: editSchema,
    renderShell: builtInEdit.renderShell,
    renderCall: builtInEdit.renderCall,
    renderResult: builtInEdit.renderResult,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { path, snapshotId, oldText, newText, replaceAll, edits: editsParam } = params as {
        path: string;
        snapshotId?: string;
        oldText?: string;
        newText?: string;
        replaceAll?: boolean;
        edits?: EditEntry[];
      };

      const { edits, replaceAll: resolvedReplaceAll } = normalizeEdits({
        oldText,
        newText,
        replaceAll,
        edits: editsParam,
      });

      return executeEdit(path, snapshotId, edits, resolvedReplaceAll, signal, ctx?.cwd ?? process.cwd());
    },
  });
}
