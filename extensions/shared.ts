import type { TextContent } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  stat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";

export type { TextContent } from "@earendil-works/pi-ai";
export {
  createWriteStream,
  mkdir,
  stat,
  fsWriteFile,
  dirname,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
};

export const STREAMING_THRESHOLD = 5 * 1024 * 1024; // ponytail: 5MB threshold, tune if large-file patterns change
export const WRITE_CHUNK_SIZE = 64 * 1024;

export function fullHash(content: string | Buffer): string {
  if (typeof content === "string") {
    return createHash("sha256").update(content, "utf-8").digest("hex");
  }
  return createHash("sha256").update(content).digest("hex");
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
