# Custom Read, Edit, Write Tools for Pi

高性能的自定义 Read, Edit, Write 工具，用于替换 Pi 中的系统内置同名工具。

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                   Pi Package (index.ts entry)                    │
│                                                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   Read Tool  │    │   Edit Tool  │    │    Write Tool    │  │
│  │  (hashline)  │    │ (hashline-   │    │   (streaming)    │  │
│  │              │    │   secured)   │    │                  │  │
│  └──────┬───────┘    └──────┬───────┘    └───────┬──────────┘  │
│         │                  │                    │              │
│         ▼                  ▼                    ▼              │
│  ┌──────────┐     ┌──────────────┐     ┌──────────────────┐   │
│  │StreamRead │     │withFileMutation│   │StreamWrite64KB   │   │
│  │256KB chk│     │    Queue      │     │  Chunks + Drain   │   │
│  └──────────┘     └──────────────┘     └──────────────────┘   │
│         │                  │                    │              │
│         ▼                  ▼                    ▼              │
│  ┌──────────────────────────────────────────────────────┐     │
│  │            Node.js fs/promises / fs streams           │     │
│  └──────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────────┘
```

### Pattern: Override Built-in Tools

All three tools are registered with the same names as Pi's built-in tools (`read`, `edit`, `write`), which causes Pi to use our implementations instead. The custom `edit` tool explicitly reuses Pi's official built-in `edit` renderer so its call/result visualization matches the native diff UI, while `read` and `write` continue to rely on built-in-compatible result shapes.

```
pi.registerTool({ name: "read", ... })   ← overrides built-in read
pi.registerTool({ name: "edit", ... })   ← overrides built-in edit
pi.registerTool({ name: "write", ... })  ← overrides built-in write
```

---

## 1. Read Tool — High-Performance with Hashline

### Design

| Feature | Implementation |
|---------|---------------|
| **Streaming read** | For files >5MB, uses `fs.createReadStream()` with 256KB chunks and a stateful line parser |
| **Normal read** | For files ≤5MB, uses `fs.readFile()` for simplicity and speed |
| **Offset/Limit** | 1-indexed line range selection |
| **Hashline output** | `withHashlines=true` returns `LINE:SHORT_HASH\|content` per line |
| **Truncation** | Uses Pi's `truncateHead()` for compatibility with Pi's built-in renderer |
| **Error handling** | Structured errors for ENOENT, EACCES, aborted operations |

### Output Format

Normal mode:
```
line1 content
line2 content
```

Hashline mode (`withHashlines=true`):
```
1:a1b2c3d4|line1 content
2:e5f6a7b8|line2 content
```

The hash is the first 8 hex characters of the SHA256 of the line content.

### Streaming Read Architecture

```
┌──────────────┐    256KB chunks     ┌──────────────────┐
│ Read Stream  │──────────────────►  │ Line Buffer      │
│ (createRead  │                     │ (accumulates     │
│  Stream)     │                     │  partial lines)  │
└──────────────┘                     └────────┬─────────┘
                                              │
                                              ▼
                                    ┌──────────────────┐
                                    │ Line Parser      │
                                    │ (split on \n,    │
                                    │  track lineIndex)│
                                    └────────┬─────────┘
                                             │
                                             ▼
                                    ┌──────────────────┐
                                    │ Collect lines in │
                                    │ [start, start+N] │
                                    └────────┬─────────┘
                                             │
                                             ▼
                                    ┌──────────────────┐
                                    │ Format (hashline │
                                    │ or plain) +      │
                                    │ truncation       │
                                    └──────────────────┘
```

## 2. Edit Tool — Hashline-Secured Precise Edits (Core Focus)

### Design

The edit tool supports **two edit modes** in a single call:

| Mode | Field | Use Case |
|------|-------|----------|
| **Text-based** | `{ oldText, newText }` | Exact text match replacement (compatibility mode) |
| **Hashline-anchored** | `{ hashline, newText }` | Position-verified replacement using LINE:HASH |

Hashline-anchored edits are the primary safety mechanism. For batched hashline edits, the tool first verifies every anchor against the original file snapshot, then applies the resulting changes in one pass. This keeps a single read snapshot valid even when earlier edits insert lines or replace a line with multiple lines.

### Hashline Mechanism

```
Workflow:
1. Read file with read(withHashlines=true)
   → Gets: 42:a1b2c3d4|const x = 1;
2. Edit file with edit(hashline="42:a1b2c3d4", newText="const x = 2;")
   → Tool reads file, computes SHA256 of line 42
   → Verifies it matches "a1b2c3d4"
   → Batches all verified hashline edits against that original snapshot
   → Only then applies the final replacements/insertions
```

**Why this matters:** Without hashline verification, if the file has shifted since the read (e.g., lines were added/deleted above), the edit could land on the wrong line. Hashline anchoring prevents this by cryptographically verifying line identity before applying changes. Batched verification against the original snapshot also means one edit in the batch cannot silently invalidate the anchors for the later edits.

### Edit Schema

```typescript
{
  path: string;
  edits: Array<{
    oldText?: string;    // exact text match (mutually exclusive with hashline)
    newText: string;     // replacement text, may be multi-line
    hashline?: string;   // "LINE:SHORT_HASH" anchor (mutually exclusive with oldText)
    wholeLine?: boolean; // default true: replace entire line; false inserts after anchor
  }>;
}
```

### Diff Output

Returns `EditToolDetails` compatible with Pi's built-in diff renderer:

```typescript
{
  diff: string;           // Unified diff format
  patch: string;          // Standard patch format
  firstChangedLine: number; // First modified line number
}
```

Pi's built-in edit renderer handles:
- Preview computation (async, shows expected changes before execution completes)
- Background coloring (green for success, yellow for pending, red for errors)
- Hunk headers (`@@ -1,3 +3,3 @@` format)

### Concurrency Safety

Uses `withFileMutationQueue()` to participate in Pi's per-file mutation queue. This ensures that if another tool (including Pi's built-in edit) modifies the same file in the same turn, operations are serialized correctly rather than racing.

```typescript
return withFileMutationQueue(absolutePath, async () => {
  // read → verify/apply edits → write all happen atomically per file
  const content = await readFile(absolutePath, "utf-8");
  let newContent = content;
  if (textEdits.length > 0) newContent = applyTextEdits(newContent, textEdits, path);
  if (hashlineEdits.length > 0) newContent = applyHashlineEdits(newContent, hashlineEdits, path);
  await fsWriteFile(absolutePath, newContent, "utf-8");
  // return diff...
});
```

### Validation

- Rejects edits with both `hashline` and `oldText` (mutually exclusive)
- Rejects edits with neither (must specify one mode)
- Rejects empty `edits` array
- For text edits: ensures `oldText` is unique in the file
- For hashline edits: requires `LINE:SHORT_HASH` format, verifies the line exists, verifies the hash matches, and rejects duplicate line targeting
- For batched hashline edits: verifies all anchors against the original snapshot before applying any insertions or multi-line replacements
- Handles legacy session format (flat `oldText`/`newText` from old sessions, JSON string `edits`)

## 3. Write Tool — Streaming Writes with Verification

### Design

| Feature | Implementation |
|---------|---------------|
| **Small files** (≤5MB) | `fs.writeFile()` atomic write |
| **Large files** (>5MB) | `fs.createWriteStream()` with 64KB chunks + drain-based backpressure |
| **SHA256 verification** | Incremental hash computed during streaming |
| **Size verification** | Compares bytes written vs. filesystem stat after write |
| **Directory creation** | `mkdir({ recursive: true })` before write |

### Streaming Write Architecture

```
┌──────────────┐    64KB chunks        ┌──────────────────┐
│ Input Buffer │─────────────────────► │ createWriteStream│
│ (content)    │   drain backpressure  │ (highWaterMark:  │
└──────────────┘   ◄─────────────      │  64KB)           │
       │                               └────────┬─────────┘
       │                                        │
       ▼                                        ▼
┌──────────────┐                        ┌──────────────────┐
│ SHA256 Hash  │◄───────────────────────│   File on disk   │
│ (incremental)│                        └──────────────────┘
└──────────────┘                               │
       │                                        │
       ▼                                        ▼
┌──────────────────────────────────────────────────────┐
│ Verification: compare size + SHA256 vs. expected      │
└──────────────────────────────────────────────────────┘
```

### Why Drain-Based Backpressure

Without backpressure control, writing a large buffer to a `WritableStream` can cause:

1. **Internal buffer overflow** — Node.js's internal buffer has a `highWaterMark` (default 16KB). Writing faster than the disk can accept causes unbounded memory growth.
2. **OOM** — If the write stream can't flush to disk fast enough, the buffered data accumulates in memory.

Our approach:
- Respects `writeStream.write()` return value (false = buffer full)
- Uses `drain` event to resume when buffer is ready
- Uses `setImmediate()` to avoid stack overflow on rapid successful writes
- 64KB chunk size balances throughput vs. memory

## Performance Optimization Notes

### Buffer Size Selection

| Operation | Chunk Size | Rationale |
|-----------|-----------|-----------|
| Streaming **read** | 256KB | Larger reads = fewer I/O operations; 256KB is below typical disk cache pressure |
| Streaming **write** | 64KB | Smaller writes = better backpressure control; 64KB aligns with common filesystem block sizes |
| Streaming **threshold** | 5MB | Below 5MB, the overhead of stream setup dominates; atomic write is faster |

### I/O Mode Choices

1. **`fs.promises.readFile` for small files** — Simple, atomic, fast for files that fit in memory. Node.js uses the OS's page cache, so repeated small reads are essentially free.

2. **`fs.createReadStream` for large files** — Streams data in fixed-size chunks from kernel space to user space. The 256KB chunk size is a good balance: smaller chunks mean more context switches, larger chunks waste memory if the requested range is small.

3. **`fs.createWriteStream` for large writes** — Uses OS-level buffering with Node.js's writable stream backpressure. The `drain` event is critical for preventing memory growth.

4. **`setImmediate` vs recursive calls** — Using `setImmediate` prevents stack overflow when the write stream's internal buffer always has room (e.g., writing to a fast SSD where every write succeeds immediately).

### Memory Profile

| File Size | Read Strategy | Peak Memory |
|-----------|--------------|-------------|
| 100KB | `readFile` | ~200KB (content + overhead) |
| 10MB | `createReadStream` | ~512KB (chunk buffer + line buffer) |
| 100MB | `createReadStream` | ~512KB (same, stream is stateless) |
| 100MB write (unverified content) | `createWriteStream` | ~65KB (single chunk in flight) |
| 100MB write (entire content in buffer) | `createWriteStream` + `Buffer.from` | ~100MB (input buffer stays in memory until stream ends) |

**Note:** The buffer input to `Buffer.from(content)` is the entire content string that the LLM sent. The LLM context window limits this to what the model can generate (typically <128K tokens ≈ few hundred KB). For truly large files (100MB+), the input would need to come from a file reference, not the LLM's content parameter.

## Error Handling

All three tools use structured error handling:

| Error | Code Path | Message |
|-------|-----------|---------|
| File not found | `access()` → `ENOENT` | `File not found: path` |
| Permission denied | `access()` → `EACCES` | `Permission denied: path` |
| Permission denied (dir) | `mkdir()` → `EACCES` | `Permission denied creating directory: dir` |
| Disk full | `writeFile()` → `ENOSPC` | `Disk full: cannot write size to path` |
| Operation aborted | `signal.aborted` check | `Operation aborted` |
| Edit oldText not found | `indexOf` returns -1 | `Edit failed: oldText not found in path` |
| Edit not unique | `indexOf` finds 2+ occurrences | `Edit failed: oldText appears multiple times` |
| Hashline parse error | Regex mismatch / wrong short hash length | `invalid hashline format` |
| Hashline line out of range | Index check | `references line X, but file has only Y lines` |
| Hashline hash mismatch | SHA256 verification | `hash mismatch at line X. Expected: ..., actual: ...` |

## Files

The implementation now uses a package-friendly multi-file structure:

- `index.ts` - root extension entry for `pi install /path/to/package`
- `extensions/shared.ts` - shared helpers, constants, path handling, hashing, and shared line splitting/joining helpers
- `extensions/read.ts` - read tool registration and streaming read logic
- `extensions/edit.ts` - edit tool registration and snapshot-verified hashline edit logic
- `extensions/write.ts` - write tool registration and streaming write logic
- `.pi/extensions/custom-tools.ts` - thin compatibility wrapper that re-exports `../../index`

**Load for local testing:**
```bash
pi -e ./index.ts
```

**Install globally as a package:**
```bash
pi install D:/gitproject/pi-tool-ex
```

**Test with `--no-builtin-tools`:**
```bash
pi --no-builtin-tools -e ./index.ts
```

## Testing

Run the full automated suite:

```bash
npm test
```

Coverage includes:

- `tests/entry.test.ts` - extension entry registers `read`, `edit`, `write`, and the `session_start` hook
- `tests/unit.test.ts` - hashline parsing/verification, snapshot-based hashline application, multi-line replacement/insertion, trailing empty-line anchors, diff generation, edit validation, and small/large file read/write execution
- `tests/integration.test.ts` - end-to-end tool execution through the real extension entry and registered tool definitions, including batched hashline edits from one read snapshot

## Requirements Audit

| Requirement | Status | How |
|------------|--------|-----|
| **Read: high-performance** | ✅ | Streaming reads for >5MB files |
| **Read: offset/limit** | ✅ | 1-indexed line range |
| **Read: hashline output** | ✅ | `LINE:HASH|content` with SHA256 |
| **Edit: hashline mechanism** | ✅ | SHA256 per-line verification against the original snapshot |
| **Edit: diff visualization** | ✅ | Returns `{diff, patch, firstChangedLine}` for Pi's built-in diff renderer |
| **Edit: precise positioning** | ✅ | Hashline prevents edit misalignment, even across batched insertions and multi-line edits |
| **Write: large file support** | ✅ | Streaming writes with drain backpressure |
| **Write: no OOM** | ✅ | 64KB chunks, stream-based |
| **Write: verification** | ✅ | File size + SHA256 hash after write |
| **Error handling** | ✅ | Structured errors for ENOENT, EACCES, ENOSPC, aborts |
| **Concurrency safety** | ✅ | `withFileMutationQueue()` for all mutations |
| **Result shape compatibility** | ✅ | Matches built-in `ReadToolDetails`, `EditToolDetails` for automatic renderer inheritance |
