import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("pi CLI can load the package entry extension", async () => {
	const repoRoot = process.cwd();
	const { stdout, stderr } = await execFileAsync(
		"cmd.exe",
		["/c", "E:\\nvm\\nodejs\\pi.cmd", "--no-extensions", "-e", "./index.ts", "--help"],
		{ cwd: repoRoot, timeout: 30000, windowsHide: true },
	);
	const output = `${stdout}${stderr}`;
	assert.match(output, /pi - AI coding assistant/i);
	assert.match(output, /--no-builtin-tools/);
	assert.doesNotMatch(output, /Failed to load extension/i);
});
