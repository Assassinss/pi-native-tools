# pi-native-tools

Pi package that overrides the built-in `bash`, `find`, `grep`, `read`, `edit`, and `write` tools.

The goal is simple:
- keep `read` / `edit` / `write` compatible with the existing hashline workflow
- replace `bash`, `find`, and `grep` with native-backed implementations
- keep the package installable through `pi install` without asking users to install extra native packages by hand

## Included tools

- `bash` - persistent native shell sessions with one-shot fallback when a session is busy
- `find` - native glob-based file search
- `grep` - native in-process content search
- `read` - file reads with offset/limit and optional hashlines
- `edit` - exact-match and hashline-anchored edits
- `write` - verified writes with streaming for large files

All tools are registered under Pi's built-in names, so installing this package replaces the default implementations.

## Why `bash`, `find`, and `grep`

- `bash` - keeps a warm native shell per cwd, so repeated commands avoid process startup and can reuse shell state; falls back to one-shot execution when a session is already busy
- `find` - walks globs in-process, respects `.gitignore`, avoids external `fd` / `rg` startup, and returns normalized relative paths
- `grep` - searches file content in-process, respects `.gitignore`, supports regex/literal/context/limits, and returns Pi-friendly truncated output without spawning `rg`


## Install

Git repo:

```bash
pi install git:github.com/Assassinss/pi-native-tools
```

SSH install form:

```bash
pi install git:git@github.com:Assassinss/pi-native-tools.git
```

## Native runtime

This package loads platform-specific native addons through `optionalDependencies`:

- `@oh-my-pi/pi-natives-win32-x64`
- `@oh-my-pi/pi-natives-linux-x64`
- `@oh-my-pi/pi-natives-linux-arm64`
- `@oh-my-pi/pi-natives-darwin-x64`
- `@oh-my-pi/pi-natives-darwin-arm64`

Users should not need to install those manually. `pi install` / `npm install` should pull the matching platform package automatically.

If the native addon is missing anyway, `extensions/omp-native.ts` throws a clear reinstall message instead of failing silently.

## Development

Install deps:

```bash
npm install
```

Run tests:

```bash
npm test
```

Run benchmarks:

```bash
npm run bench
```

Convert a raw JSON run log into eval JSONL:

```bash
npm run convert:tool-calls
```

Run the sample tool-calling eval:

```bash
npm run eval:tool-calls
```

The eval script compares an expected case file against a model/tool-call result file and reports:
- strict pass / soft pass / fail
- first-tool accuracy
- argument-check accuracy
- sequence accuracy for multi-step flows
- bash overuse
- a simple confusion matrix

Files:
- `evals/tool-calls.jsonl` - expected prompts, tools, forbidden tools, and arg checks; now includes more realistic confusion cases for read/find/grep/bash/write/edit
- `evals/tool-calls.runs-template.json` - blank template for your own captured runs
- `evals/tool-calls.raw-sample.json` - sample raw JSON log input for conversion
- `evals/tool-calls.sample-results.jsonl` - already-normalized sample run output format
- `scripts/convert-tool-call-runs.ts` - raw JSON to eval JSONL converter
- `scripts/eval-tool-calls.ts` - scorer

Expected normalized results file shape:

```json
{"id":"grep-literal","toolCalls":[{"tool":"grep","args":{"pattern":"fetchUser(","literal":true}}]}
```

Supported raw JSON shapes for conversion:
- top-level array, or object with `runs` / `items` / `records` / `results`
- tool call arrays under `toolCalls` / `tool_calls` / `calls` / `invocations`
- tool names under `tool`, `name`, or `function.name`
- arguments under `args`, `arguments`, `input`, `parameters`, or `function.arguments`

Typical flow:

```bash
node scripts/convert-tool-call-runs.ts your-raw-runs.json evals/your-runs.jsonl
node scripts/eval-tool-calls.ts evals/tool-calls.jsonl evals/your-runs.jsonl
```

## Project layout

- `index.ts` - package entry, registers all tool overrides
- `extensions/bash.ts` - native bash override
- `extensions/find.ts` - native find override
- `extensions/grep.ts` - native grep override
- `extensions/omp-native.ts` - platform native loader shim
- `extensions/read.ts` - read override
- `extensions/edit.ts` - edit override
- `extensions/write.ts` - write override
- `tests/` - unit and integration coverage
- `scripts/bench.ts` - local benchmark script

## Notes

- `bash` is optimized for repeated commands in the same cwd; true one-shot commands may still be slower than Pi's old shell path
- `find` and `grep` are meant to avoid external `fd` / `rg` process startup
- `read`, `edit`, and `write` stay focused on safe file operations, not editor-like features
