# pi-native-tools

Pi package that replaces the built-in `bash`, `find`, `grep`, and `write` tools with
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

Native glob search with normalized relative paths. Only use when you don't know the file path.

### grep

Native in-process search with regex, literal, context, locations, content, count, and
files-with-matches modes. The default `locations` mode returns compact `file:line` results (grouped
as `file:start-end`) without copying matching source text into context.

```text
grep({ pattern: "needle", path: "." })
→ src/main.ts:12,30-34
```

Use `mode: "content"` when the matching text itself is needed. Use `context` with locations to
expand each returned line into a line range. Use grep only to search across
files for patterns, symbols, or definitions — never as a substitute for reading a file.

Write content to a file with streaming support, verified writes, hashline stripping, and
shebang executable support on Unix-like systems.

## Dev

```bash
npm install
npm test
```
