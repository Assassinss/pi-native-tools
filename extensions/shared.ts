import type { TextContent } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  stat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

export type { TextContent } from "@earendil-works/pi-ai";
export {
  createWriteStream,
  mkdir,
  readFile,
  stat,
  fsWriteFile,
  basename,
  dirname,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
};

export const STREAMING_THRESHOLD = 5 * 1024 * 1024; // ponytail: 5MB threshold, tune if large-file patterns change
export const WRITE_CHUNK_SIZE = 64 * 1024;
export const HASH_SHORT_LEN = 8;

export type LineContent = {
  lines: string[];
  endsWithNewline: boolean;
};

export function splitContentLines(content: string): LineContent {
  if (content.length === 0) return { lines: [], endsWithNewline: false };
  const endsWithNewline = content.endsWith("\n");
  const normalized = endsWithNewline ? content.slice(0, -1) : content;
  return {
    lines: normalized.split("\n"),
    endsWithNewline,
  };
}

export function joinContentLines(
  lines: string[],
  endsWithNewline: boolean,
): string {
  if (lines.length === 0) return "";
  return `${lines.join("\n")}${endsWithNewline ? "\n" : ""}`;
}

// ponytail: FNV-1a non-crypto hash, upgrade to SHA-256 if hash collision causes real issues
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function shortHash(
  content: string,
  len: number = HASH_SHORT_LEN,
): string {
  return fnv1a(content).toString(16).padStart(8, "0").slice(0, len);
}

export function fullHash(content: string | Buffer): string {
  if (typeof content === "string") {
    return createHash("sha256").update(content, "utf-8").digest("hex");
  }
  return createHash("sha256").update(content).digest("hex");
}

export type DocumentFingerprint = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino?: number | bigint;
};

type DocumentHistory = {
  currentRevisionId: string;
  fingerprint?: DocumentFingerprint;
};

const documentHistories = new Map<string, DocumentHistory>();

export function createRevisionId(content: string | Buffer): string {
  return `rev_${fullHash(content).slice(0, 12)}`;
}

export function createStatRevisionId(fileStat: DocumentFingerprint): string {
  return createRevisionId(
    `${fileStat.size}:${fileStat.mtimeMs}:${fileStat.ctimeMs}:${String(fileStat.ino ?? "")}`,
  );
}

export function rememberDocumentRevision(
  absolutePath: string,
  revisionId: string,
  fingerprint?: DocumentFingerprint,
): string {
  let history = documentHistories.get(absolutePath);
  if (!history) {
    history = {
      currentRevisionId: revisionId,
      fingerprint,
    };
    documentHistories.set(absolutePath, history);
  }
  history.currentRevisionId = revisionId;
  if (fingerprint !== undefined) history.fingerprint = { ...fingerprint };
  return revisionId;
}

export function getCurrentDocumentRevision(
  absolutePath: string,
): string | undefined {
  return documentHistories.get(absolutePath)?.currentRevisionId;
}

export function getDocumentFingerprint(absolutePath: string): DocumentFingerprint | undefined {
  return documentHistories.get(absolutePath)?.fingerprint;
}

export function normalizePath(path: string, cwd: string): string {
  let p = path;
  if (p.startsWith("@")) p = p.slice(1);
  return resolve(cwd, p);
}

export type ToolErrorPayload = {
  tool: string;
  code: string;
  message: string;
  retryable?: boolean;
  hint?: string;
  details?: Record<string, unknown>;
};

export function formatToolError(payload: ToolErrorPayload): string {
  const structured = {
    tool: payload.tool,
    code: payload.code,
    message: payload.message,
    retryable: payload.retryable ?? false,
    ...(payload.hint ? { hint: payload.hint } : {}),
    ...(payload.details ? { details: payload.details } : {}),
  };
  return `TOOL_ERROR ${JSON.stringify(structured)}\n${payload.message}`;
}

export function toolError(payload: ToolErrorPayload): Error {
  return new Error(formatToolError(payload));
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw toolError({
      tool: "shared",
      code: "aborted",
      message: "Operation aborted",
      retryable: true,
    });
  }
}
