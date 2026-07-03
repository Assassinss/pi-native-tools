import { createEditToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  dirname,
  fsWriteFile,
  getDocumentSnapshot,
  normalizePath,
  readFile,
  rememberDocumentSnapshot,
  throwIfAborted,
  toolError,
  withFileMutationQueue,
} from "./shared.ts";
import { invalidateFsScanCache } from "./omp-native.ts";

type EditConflictReason = "not_found" | "ambiguous" | "stale_snapshot" | "overlap";

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
      Type.String({ description: "Snapshot id returned by read(details.snapshotId). Optional but recommended." }),
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

type EditEntry = { oldText: string; newText: string };

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
): { content: Array<{ type: "text"; text: string }>; details: EditResultDetails } {
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

async function verifyEditWrite(absolutePath: string, path: string, expectedContent: string): Promise<void> {
  let writtenContent: string;
  try {
    writtenContent = (await readFile(absolutePath)).toString("utf-8");
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

function invalidateScanCache(absolutePath: string): void {
  invalidateFsScanCache?.(absolutePath);
  invalidateFsScanCache?.(dirname(absolutePath));
}

/**
 * Apply batch edits against original content.
 * Each oldText must match exactly once and not overlap with other edits.
 * Returns conflict result object directly (instead of throwing) so caller can handle it.
 */
function applyBatchEdits(
  content: string,
  edits: EditEntry[],
  path: string,
): { newContent: string; appliedCount: number } | { conflict: ReturnType<typeof buildConflict> } {
  // Find position for each edit, checking uniqueness
  const positions: Array<{ index: number; oldText: string; newText: string }> = [];
  for (const edit of edits) {
    const matches = findMatchIndices(content, edit.oldText);
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
      return {
        conflict: buildConflict(
          "ambiguous",
          `oldText matched ${matches.length} locations in ${path}. Narrow the text and retry.`,
          undefined,
          candidates,
        ),
      };
    }
    positions.push({ index: matches[0], oldText: edit.oldText, newText: edit.newText });
  }

  // Check for overlaps (positions are in discovery order, sort by index)
  positions.sort((a, b) => a.index - b.index);
  for (let i = 1; i < positions.length; i++) {
    const prevEnd = positions[i - 1].index + positions[i - 1].oldText.length;
    if (positions[i].index < prevEnd) {
      const a = positions[i - 1];
      const b = positions[i];
      throw editError(
        "overlap",
        `Edits overlap in ${path}: "${a.oldText.slice(0, 40)}..." and "${b.oldText.slice(0, 40)}..." touch the same region. Merge them into one edit.`,
        "Combine overlapping edits into a single oldText/newText pair.",
        { path },
      );
    }
  }

  // Apply in reverse order to preserve indices
  let result = content;
  for (let i = positions.length - 1; i >= 0; i--) {
    const { index, oldText, newText } = positions[i];
    result = result.slice(0, index) + newText + result.slice(index + oldText.length);
  }

  return { newContent: result, appliedCount: edits.length };
}

/** Normalize legacy oldText/newText + edits[] into a flat edits array. */
function normalizeEdits(params: {
  oldText?: string;
  newText?: string;
  replaceAll?: boolean;
  edits?: EditEntry[];
}): { edits: EditEntry[]; replaceAll: boolean } {
  const result: EditEntry[] = [];

  if (params.edits && params.edits.length > 0) {
    result.push(...params.edits);
  }

  if (params.oldText && params.newText !== undefined) {
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

    const currentSnapshotId = rememberDocumentSnapshot(absolutePath, content);
    if (snapshotId && snapshotId !== currentSnapshotId) {
      const previousSnapshot = getDocumentSnapshot(absolutePath, snapshotId);
      if (!previousSnapshot || !edits.some((e) => previousSnapshot.includes(e.oldText))) {
        return buildConflict(
          "stale_snapshot",
          `Snapshot ${snapshotId} is stale for ${path}. Re-read the file before retrying.`,
          currentSnapshotId,
        );
      }
    }

    // Batch mode (always use batch path; single edit is just a batch of 1)
    if (edits.length > 1 || (edits.length === 1 && !replaceAll)) {
      const batchResult = applyBatchEdits(content, edits, path);
      if ("conflict" in batchResult) {
        // If snapshot was stale, surface that as the conflict reason
        if (snapshotId && snapshotId !== currentSnapshotId) {
          return buildConflict(
            "stale_snapshot",
            `Snapshot ${snapshotId} no longer matches ${path}. Re-read the file before retrying.`,
            currentSnapshotId,
          );
        }
        return batchResult.conflict;
      }

      const { newContent, appliedCount } = batchResult;
      if (newContent === content) {
        return buildConflict("not_found", `Edit made no changes to ${path}.`, currentSnapshotId);
      }

      await writeAndVerify(absolutePath, path, newContent, signal);
      const newSnapshotId = rememberDocumentSnapshot(absolutePath, newContent);
      invalidateScanCache(absolutePath);

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

    // Legacy replaceAll mode (single edit)
    const single = edits[0];
    const matches = findMatchIndices(content, single.oldText);
    if (matches.length === 0) {
      return buildConflict(
        snapshotId && snapshotId !== currentSnapshotId ? "stale_snapshot" : "not_found",
        snapshotId && snapshotId !== currentSnapshotId
          ? `Snapshot ${snapshotId} no longer matches ${path}. Re-read the file before retrying.`
          : `oldText was not found in ${path}.`,
        currentSnapshotId,
      );
    }

    if (!replaceAll && matches.length > 1) {
      return buildConflict(
        "ambiguous",
        `oldText matched ${matches.length} locations in ${path}. Narrow the text and retry.`,
        currentSnapshotId,
        matches.slice(0, 3).map((index) => ({ preview: buildPreview(content, index, single.oldText) })),
      );
    }

    const nextContent = replaceAll ? content.split(single.oldText).join(single.newText) : content.replace(single.oldText, single.newText);
    if (nextContent === content) return buildConflict("not_found", `Edit made no changes to ${path}.`, currentSnapshotId);

    await writeAndVerify(absolutePath, path, nextContent, signal);
    const newSnapshotId = rememberDocumentSnapshot(absolutePath, nextContent);
    invalidateScanCache(absolutePath);

    const appliedCount = replaceAll ? matches.length : 1;
    return {
      content: [
        {
          type: "text",
          text: `Applied ${appliedCount} replacement${appliedCount === 1 ? "" : "s"} to ${path}.\nsnapshotId: ${newSnapshotId}\nUse this snapshotId for your next edit on this file — no need to re-read.`,
        },
      ],
      details: { status: "applied", appliedCount, newSnapshotId },
    };
  });
}

async function writeAndVerify(
  absolutePath: string,
  path: string,
  content: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    await fsWriteFile(absolutePath, content, "utf-8");
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
  await verifyEditWrite(absolutePath, path, content);
}

export function registerEditTool(pi: ExtensionAPI): void {
  const builtInEdit = createEditToolDefinition(process.cwd());

  pi.registerTool({
    name: "edit",
    label: "edit",
    description: "Edit a file by replacing exact oldText with newText, optionally against a read snapshot. Use edits[] for multiple disjoint replacements in one call.",
    promptSnippet: "Apply exact oldText/newText replacements with optional snapshot checks",
    promptGuidelines: [
      "You must read the file first to get the current text, then call edit with oldText/newText and the snapshotId from that read.",
      "Always include snapshotId — without it stale edits won't be detected and you may silently overwrite concurrent changes.",
      "After a successful edit, the response includes a new snapshotId. Use it for your next edit on the same file — no need to re-read.",
      "Prefer unique oldText snippets. If edit returns ambiguous, read a smaller region and retry with a longer oldText.",
      "Use replaceAll only when every exact match should change.",
      "When changing multiple separate locations in one file, use one edit call with edits[] instead of multiple edit calls.",
      "Each edits[].oldText is matched against the original file, not incrementally. Do not include overlapping edits.",
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
