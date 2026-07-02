# pi-native-tools

Pi package that replaces the built-in `bash`, `find`, `grep`, `read`, `edit`, and `write` tools.

It keeps the same tool names, but swaps in:
- native-backed `bash`, `find`, and `grep`
- safer `read`, `edit`, and `write` behavior for hashline-based file workflows

## Install

```bash
pi install git:github.com/Assassinss/pi-native-tools
```

SSH form:

```bash
pi install git:git@github.com:Assassinss/pi-native-tools.git
```

## Highlights

- `bash` - warm native shell sessions for faster repeated commands
- `find` - native glob search with normalized relative paths
- `grep` - native in-process search with regex, literal, context, count, and files-with-matches modes
- `read` - `offset` / `limit`, explicit `ranges`, optional context windows, hashline output, `details.revisionId`, binary/NUL rejection, and large-file streaming with line-snapshot fallback for later edits
- `edit` - hashline-anchored edits, original-snapshot matching, `baseRevisionId`-based automatic rebase, `changedRanges` handoff for follow-up edits, no-op loop protection, and post-write verification
- `write` - parent directory creation, verified writes, large-file streaming, hashline stripping, and shebang executable support on Unix-like systems

## Examples

Read a normal slice:

```json
{
  "path": "src/app.ts",
  "offset": 20,
  "limit": 40
}
```

Read multiple ranges with context:

```json
{
  "path": "src/app.ts",
  "ranges": [
    { "start": 20, "end": 40 },
    { "start": 120, "end": 125, "before": 2, "after": 2 }
  ]
}
```

Read with hashlines before an anchored edit:

```json
{
  "path": "src/app.ts",
  "ranges": [
    { "start": 80, "end": 90 }
  ],
  "withHashlines": true
}
```

Apply a hashline-based edit:

```json
{
  "path": "src/app.ts",
  "baseRevisionId": "rev_1234abcd5678",
  "edits": [
    {
      "hashline": "84:a1b2c3d4",
      "newText": "const enabled = true;"
    }
  ]
}
```

Write copied hashline content safely:

```json
{
  "path": "notes.txt",
  "content": "[notes.txt#deadbeef]\n1:11111111|hello\n2:22222222|world"
}
```

Written file content:

```text
hello
world
```

## Hashline Continuation Flow

1. `read(..., withHashlines=true)` returns normal hashline output plus `details.revisionId`
2. `edit(..., baseRevisionId=...)` can safely reuse that snapshot even after nearby line shifts caused by earlier edits in the same tool session
3. successful `edit` returns:
   - `details.revisionId` for the new file state
   - `details.changedRanges` with fresh `LINE:HASH|text` windows near each change
   - matching text output so the next tool call can often skip another `read`
4. if the file changed externally and rebase is no longer safe, `edit` fails with `needs_refresh`

`changedRanges` is intentionally capped so tool output stays small enough for the model to keep using it:
- up to 3 changed hunks
- up to 12 hashlines per hunk
- truncated hunks are marked in both text output and `details.changedRanges`

## Notes

- `read` `ranges` cannot be combined with `offset` / `limit`
- `read` returns recovery guidance for out-of-range offsets
- `bash` is optimized for repeated commands in the same cwd; true one-shot commands may still be slower than the old shell path

## Dev

```bash
npm install
npm test
npm run bench
npm run test:hashline-flow
```

`npm run test:hashline-flow` prints a readable PASS/FAIL summary for:
- changedRanges reuse without a follow-up `read`
- automatic rebase from stale hashlines
- large-file / streaming window fallback
- external edits correctly returning `needs_refresh`
