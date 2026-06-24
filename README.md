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
