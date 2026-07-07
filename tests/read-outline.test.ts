import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeRead } from "../extensions/read.ts";

function extractText(result: { content: Array<{ type: string; text: string }> }): string {
	return result.content.map((item) => item.text).join("\n");
}

test("executeRead outline returns structural declarations for TypeScript", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-read-outline-ts-"));
	try {
		const file = join(dir, "demo.ts");
		await writeFile(file, [
			"import { foo } from './bar';",
			"",
			"export function hello() { return 1; }",
			"export class World {",
			"  method() {}",
			"}",
			"interface X { a: number }",
			"type Y = string;",
			"",
		].join("\n"), "utf-8");

		const result = await executeRead(file, undefined, undefined, undefined, dir, undefined, true, undefined);
		const text = extractText(result);
		assert.match(text, /\[outline for demo\.ts — 5 declarations\]/);
		assert.match(text, /1: import \{ foo \} from '\.\/bar';/);
		assert.match(text, /3: export function hello\(\) \{ return 1; \}/);
		assert.match(text, /4: export class World \{/);
		assert.match(text, /7: interface X \{ a: number \}/);
		assert.match(text, /8: type Y = string;/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead outline for Python detects def, class, decorators, imports", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-read-outline-py-"));
	try {
		const file = join(dir, "demo.py");
		await writeFile(file, [
			"import os",
			"from typing import List",
			"",
			"@decorator",
			"def hello():",
			"    pass",
			"",
			"class World:",
			"    async def run(self):",
			"        pass",
			"",
		].join("\n"), "utf-8");

		const result = await executeRead(file, undefined, undefined, undefined, dir, undefined, true, undefined);
		const text = extractText(result);
		assert.match(text, /\[outline for demo\.py — 6 declarations\]/);
		assert.match(text, /1: import os/);
		assert.match(text, /2: from typing import List/);
		assert.match(text, /4: @decorator/);
		assert.match(text, /5: def hello\(\):/);
		assert.match(text, /8: class World:/);
		assert.match(text, /9: async def run\(self\):/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead outline for Markdown detects headings", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-read-outline-md-"));
	try {
		const file = join(dir, "demo.md");
		await writeFile(file, [
			"# Title",
			"text",
			"## Section 1",
			"more text",
			"### Subsection",
			"",
		].join("\n"), "utf-8");

		const result = await executeRead(file, undefined, undefined, undefined, dir, undefined, true, undefined);
		const text = extractText(result);
		assert.match(text, /\[outline for demo\.md — 3 declarations\]/);
		assert.match(text, /1: # Title/);
		assert.match(text, /3: ## Section 1/);
		assert.match(text, /5: ### Subsection/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead outline + ranges returns both structure and content", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-read-outline-ranges-"));
	try {
		const file = join(dir, "demo.ts");
		await writeFile(file, [
			"import { foo } from './bar';",
			"",
			"export function hello() { return 1; }",
			"export function world() { return 2; }",
			"",
		].join("\n"), "utf-8");

		const result = await executeRead(
			file,
			undefined,
			undefined,
			undefined,
			dir,
			[{ start: 3, end: 4 }],
			true,
			undefined,
		);
		const text = extractText(result);
		assert.match(text, /\[outline for demo\.ts/);
		assert.match(text, /---/);
		assert.match(text, /\[lines 3-4\]/);
		assert.match(text, /3\|export function hello/);
		assert.match(text, /4\|export function world/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead dedup blocks re-read of unchanged file", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-read-dedup-"));
	try {
		const file = join(dir, "demo.txt");
		await writeFile(file, "hello\nworld\n", "utf-8");

		const first = await executeRead(file, 1, 2, undefined, dir, undefined, undefined, undefined);
		const firstText = extractText(first);
		assert.match(firstText, /hello/);
		const sid = (first.details as { snapshotId?: string })?.snapshotId;
		assert.ok(sid);

		const second = await executeRead(file, 1, 2, undefined, dir, undefined, undefined, undefined);
		const secondText = extractText(second);
		assert.match(secondText, /Content unchanged since your last read/);
		assert.match(secondText, /Content is already in your context/);
		assert.match(secondText, new RegExp(sid!.replace("rev_", "rev_")));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead force bypasses dedup", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-read-force-"));
	try {
		const file = join(dir, "demo.txt");
		await writeFile(file, "hello\nworld\n", "utf-8");

		await executeRead(file, 1, 2, undefined, dir, undefined, undefined, undefined);
		const forced = await executeRead(file, 1, 2, undefined, dir, undefined, undefined, true);
		const forcedText = extractText(forced);
		assert.match(forcedText, /hello/);
		assert.doesNotMatch(forcedText, /Content unchanged/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead outline does not seed mtime for dedup (ranges after outline reads content)", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-read-outline-no-mtime-"));
	try {
		const file = join(dir, "demo.ts");
		await writeFile(file, "import { foo } from './bar';\nexport function hello() {}\nexport function world() {}\n", "utf-8");

		// outline-only should not seed mtime
		const outlineResult = await executeRead(file, undefined, undefined, undefined, dir, undefined, true, undefined);
		assert.match(extractText(outlineResult), /\[outline for demo\.ts/);

		// ranges read after outline should NOT be deduped — content was never returned
		const rangesResult = await executeRead(file, undefined, undefined, undefined, dir, [{ start: 2, end: 3 }], undefined, undefined);
		const rangesText = extractText(rangesResult);
		assert.match(rangesText, /2\|export function hello/);
		assert.match(rangesText, /3\|export function world/);
		assert.doesNotMatch(rangesText, /Content unchanged/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead outline + ranges dedups ranges part when unchanged", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-read-outline-ranges-dedup-"));
	try {
		const file = join(dir, "demo.ts");
		await writeFile(file, "import { foo } from './bar';\nexport function hello() {}\n", "utf-8");

		const first = await executeRead(file, undefined, undefined, undefined, dir, [{ start: 1, end: 2 }], true, undefined);
		assert.match(extractText(first), /\[outline for demo\.ts/);
		assert.match(extractText(first), /1\|import/);

		const second = await executeRead(file, undefined, undefined, undefined, dir, [{ start: 1, end: 2 }], true, undefined);
		const secondText = extractText(second);
		assert.match(secondText, /\[outline for demo\.ts/);
		assert.match(secondText, /Ranges content unchanged since your last read/);
		assert.match(secondText, /Content is already in your context/);
		assert.doesNotMatch(secondText, /1\|import/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead outline never blocked by dedup", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-read-outline-dedup-"));
	try {
		const file = join(dir, "demo.ts");
		await writeFile(file, "import { foo } from './bar';\nexport function hello() {}\n", "utf-8");

		const first = await executeRead(file, 1, 2, undefined, dir, undefined, undefined, undefined);
		assert.match(extractText(first), /hello/);

		const second = await executeRead(file, undefined, undefined, undefined, dir, undefined, true, undefined);
		const secondText = extractText(second);
		assert.match(secondText, /\[outline for demo\.ts/);
		assert.doesNotMatch(secondText, /Content unchanged/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead dedup detects actual file changes via mtime", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-read-dedup-mtime-"));
	try {
		const file = join(dir, "demo.txt");
		await writeFile(file, "v1\n", "utf-8");

		await executeRead(file, 1, 1, undefined, dir, undefined, undefined, undefined);
		await writeFile(file, "v2\n", "utf-8");

		const third = await executeRead(file, 1, 1, undefined, dir, undefined, undefined, undefined);
		const thirdText = extractText(third);
		assert.match(thirdText, /v2/);
		assert.doesNotMatch(thirdText, /Content unchanged/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead partial range read does not block reading a different range", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-read-partial-no-block-"));
	try {
		const file = join(dir, "demo.ts");
		await writeFile(file, "line1\nline2\nline3\nline4\nline5\n", "utf-8");

		// Read lines 1-2 (partial) — should not seed mtime
		const first = await executeRead(file, undefined, undefined, undefined, dir, [{ start: 1, end: 2 }], undefined, undefined);
		assert.match(extractText(first), /1\|line1/);
		assert.match(extractText(first), /2\|line2/);

		// Read lines 4-5 (different range) — should NOT be deduped
		const second = await executeRead(file, undefined, undefined, undefined, dir, [{ start: 4, end: 5 }], undefined, undefined);
		const secondText = extractText(second);
		assert.match(secondText, /4\|line4/);
		assert.match(secondText, /5\|line5/);
		assert.doesNotMatch(secondText, /Content unchanged/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead offset/limit partial read does not block reading a different offset", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-read-offset-no-block-"));
	try {
		const file = join(dir, "demo.txt");
		await writeFile(file, "line1\nline2\nline3\nline4\nline5\n", "utf-8");

		// Read first 2 lines (partial) — should not seed mtime
		const first = await executeRead(file, 1, 2, undefined, dir, undefined, undefined, undefined);
		assert.match(extractText(first), /line1/);
		assert.match(extractText(first), /line2/);

		// Read from offset 4 (different section) — should NOT be deduped
		const second = await executeRead(file, 4, 2, undefined, dir, undefined, undefined, undefined);
		const secondText = extractText(second);
		assert.match(secondText, /line4/);
		assert.match(secondText, /line5/);
		assert.doesNotMatch(secondText, /Content unchanged/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("executeRead full range read does seed mtime and dedups subsequent full reads", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-read-full-range-dedup-"));
	try {
		const file = join(dir, "demo.ts");
		await writeFile(file, "line1\nline2\nline3\n", "utf-8");

		// Read lines 1-3 with range covering full file — should seed mtime
		const first = await executeRead(file, undefined, undefined, undefined, dir, [{ start: 1, end: 3 }], undefined, undefined);
		assert.match(extractText(first), /line1/);

		// Read same range again — should be deduped
		const second = await executeRead(file, undefined, undefined, undefined, dir, [{ start: 1, end: 3 }], undefined, undefined);
		const secondText = extractText(second);
		assert.match(secondText, /Content unchanged/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
