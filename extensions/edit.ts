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

type EditConflictReason = "not_found" | "ambiguous" | "stale_snapshot";

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

const editSchema = Type.Object(
  {
    path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
    snapshotId: Type.Optional(
      Type.String({ description: "Snapshot id returned by read(details.snapshotId). Optional but recommended." }),
    ),
    oldText: Type.String({ description: "Exact existing text to replace." }),
    newText: Type.String({ description: "Replacement text." }),
    replaceAll: Type.Optional(Type.Boolean({ description: "Replace every exact match. Default: false." })),
  },
  { additionalProperties: false },
);

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

export async function executeEdit(
  path: string,
  snapshotId: string | undefined,
  oldText: string,
  newText: string,
  replaceAll: boolean | undefined,
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<{ content: Array<{ type: string; text: string }>; details: EditResultDetails }> {
  if (oldText.length === 0) {
    throw editError(
      "invalid_input",
      "Edit failed: oldText must be a non-empty string.",
      "Pass the exact existing text you want to replace.",
      { path },
    );
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
      if (!previousSnapshot || !previousSnapshot.includes(oldText)) {
        return buildConflict(
          "stale_snapshot",
          `Snapshot ${snapshotId} is stale for ${path}. Re-read the file before retrying.`,
          currentSnapshotId,
        );
      }
    }

    const matches = findMatchIndices(content, oldText);
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
        matches.slice(0, 3).map((index) => ({ preview: buildPreview(content, index, oldText) })),
      );
    }

    const nextContent = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
    if (nextContent === content) return buildConflict("not_found", `Edit made no changes to ${path}.`, currentSnapshotId);

    try {
      await fsWriteFile(absolutePath, nextContent, "utf-8");
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

    await verifyEditWrite(absolutePath, path, nextContent);
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
      details: {
        status: "applied",
        appliedCount,
        newSnapshotId,
      },
    };
  });
}

export function registerEditTool(pi: ExtensionAPI): void {
  const builtInEdit = createEditToolDefinition(process.cwd());

  pi.registerTool({
    name: "edit",
    label: "edit",
    description: "Edit a file by replacing exact oldText with newText, optionally against a read snapshot.",
    promptSnippet: "Apply exact oldText/newText replacements with optional snapshot checks",
    promptGuidelines: [
      "You must read the file first to get the current text, then call edit with oldText/newText and the snapshotId from that read.",
      "Always include snapshotId — without it stale edits won't be detected and you may silently overwrite concurrent changes.",
      "After a successful edit, the response includes a new snapshotId. Use it for your next edit on the same file — no need to re-read.",
      "Prefer unique oldText snippets. If edit returns ambiguous, read a smaller region and retry with a longer oldText.",
      "Use replaceAll only when every exact match should change.",
    ],
    parameters: editSchema,
    renderShell: builtInEdit.renderShell,
    renderCall: builtInEdit.renderCall,
    renderResult: builtInEdit.renderResult,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { path, snapshotId, oldText, newText, replaceAll } = params as {
        path: string;
        snapshotId?: string;
        oldText: string;
        newText: string;
        replaceAll?: boolean;
      };
      return executeEdit(path, snapshotId, oldText, newText, replaceAll, signal, ctx?.cwd ?? process.cwd());
    },
  });
}
