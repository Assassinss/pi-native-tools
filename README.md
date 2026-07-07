# pi-native-tools

Pi package that replaces the built-in `bash`, `find`, `grep`, `read`, `edit`, and `write` tools with
native-backed, simpler versions.

## Install

```bash
pi install git:github.com/Assassinss/pi-native-tools
```

## Tools

### bash

Warm native shell sessions for faster repeated commands. Supports `session`, `resetSession`, and
`timeout` controls.

### find

Native glob search with normalized relative paths. Only use when you don't know the file path —
if you already have a file name, use `read` directly.

### grep

Native in-process search with regex, literal, context, count, and files-with-matches modes. Use
only to search across files for patterns, symbols, or definitions — never as a substitute for
reading a file. Accepts `output_mode` and `outputMode` as aliases for `mode`.

### read

Read file contents. The primary way to inspect files — when you know the file path, call `read`
directly, don't `grep` or `find` first. Returns a `snapshotId` at the end of its output text for
use with `edit`.

Parameters: `path`, `offset` / `limit`, explicit `ranges` with optional `before`/`after` context,
`outline`, `force`, binary/NUL rejection, and large-file streaming.

**`outline`** — returns a structural outline (function/class/type declarations with line numbers)
instead of full content. Supports TS/JS/Python/Rust/Go/Java/C/C++/Markdown/JSON/YAML via regex
patterns; other files fall back to top-level non-empty lines. Combine `outline` with `ranges` to
get structure + target content in one call.

**Dedup** — unchanged re-reads are blocked automatically. When the file's mtime hasn't changed
since the last full read, `read` returns a short `Content unchanged ... Content is already in your
context.` message instead of re-sending content. Only full-file reads seed the dedup cache;
partial reads (`offset`/`limit`/partial `ranges`/`outline`-only) don't block subsequent reads of
other sections.

**`force`** — escape hatch to bypass dedup. Not mentioned in prompt guidelines or schema
description so agents don't preemptively bypass dedup; the dedup message itself tells the agent
when to use it.

### edit

Edit a file by replacing exact `oldText` with `newText`. Requires a prior `read` to get the
current text and `snapshotId`.

Parameters: `path`, `snapshotId` (required — from the last `read` of this file), `oldText`,
`newText`, `replaceAll` (default `false`).

Conflict responses:
- `not_found` — oldText doesn't exist in the file
- `ambiguous` — oldText matched multiple locations; narrow and retry
- `stale_snapshot` — file changed since last read; re-read and retry

After a successful edit, the response includes a new `snapshotId` and the message
"Use this snapshotId for your next edit on this file — no need to re-read."

### write

Write content to a file with streaming support, verified writes, hashline stripping, and
shebang executable support on Unix-like systems.

## Simple Edit Flow

```
read(path, ...)          → returns text + "snapshotId: rev_xxx"
edit(path, snapshotId=rev_xxx, oldText, newText)  → applies replacement + returns new snapshotId
```

1. `read` the file to get current text and `snapshotId`
2. `edit` with `oldText`/`newText` and the `snapshotId` from step 1
3. For follow-up edits on the same file, use the `snapshotId` from the edit response directly —
   no need to re-read
4. Only re-read when `edit` returns `stale_snapshot` or `ambiguous`
5. To discover a file's structure before reading specific sections, use `outline=true` (optionally
   combined with `ranges` for structure + content in one call)

## Dev

```bash
npm install
npm test
```
