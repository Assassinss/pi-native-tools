import test from "node:test";
import assert from "node:assert/strict";
import { classifyCommand, type OutputPolicy } from "../extensions/bash.ts";

const cases: Record<OutputPolicy, string[]> = {
	result: [
		"pwd",
		"git status",
		"git -C packages/app log --oneline",
		"rg \"classifyCommand\" extensions",
		"cat package.json",
		"npm --version",
		"npm help",
		"docker ps",
		"docker compose config",
		"dotnet --version",
		"dotnet --list-sdks",
		"terraform version",
		"terraform fmt",
		"terraform output",
		"just --list",
		"task --list",
	],
	diagnostic: [
		"npm test",
		"npm run lint",
		"npm --prefix packages/app test",
		"pnpm -C packages/app run typecheck",
		"yarn workspace web test",
		"npx eslint .",
		"python -m pytest",
		"cargo check",
		"go test ./...",
		"git diff --check",
		"make test",
		"dotnet test",
		"dotnet format --verify-no-changes",
		"swift test",
		"zig test src/main.zig",
		"dart test",
		"flutter test",
		"dart analyze",
		"ktlint",
		"sbt test",
		"mix test",
		"stack test",
		"cabal test",
		"terraform validate",
		"terraform plan",
		"poetry check",
		"uv lock",
		"oxlint .",
	],
	progress: [
		"npm install",
		"npm run build --silent",
		"pnpm --filter web build",
		"git clone https://example.com/repo.git",
		"cargo build --release",
		"go build ./...",
		"docker build .",
		"docker compose up -d",
		"make all",
		"dotnet build",
		"dotnet run",
		"dotnet publish",
		"swift build",
		"zig build",
		"flutter build apk",
		"sbt compile",
		"mix compile",
		"stack build",
		"cabal build",
		"terraform apply",
		"terraform init",
		"poetry install",
		"uv sync",
		"just build",
		"task build",
		"ansible-playbook deploy.yml",
	],
	passthrough: [
		"npm run custom-script",
		"printf \"npm test\"",
		"echo \"git status\"",
		"npm test | tee test.log",
		"npm test && git status",
		"kubectl get pods",
		"kubectl apply -f deployment.yaml",
		"kubectl describe pod",
		"tsx script.ts",
		"uv run python script.py",
		"just custom-recipe",
	],
};

test("classifyCommand distinguishes command output policies", () => {
	for (const [expected, commands] of Object.entries(cases) as Array<[OutputPolicy, string[]]>) {
		for (const command of commands) {
			assert.equal(classifyCommand(command), expected, `${command} should be ${expected}`);
		}
	}
});

test("classifyCommand ignores shell wrappers, assignments, and quoted operators", () => {
	assert.equal(classifyCommand("FOO=1 env BAR=2 timeout 10 npm test"), "diagnostic");
	assert.equal(classifyCommand("bash -c 'npm run build'"), "progress");
	assert.equal(classifyCommand("printf 'npm test && git status'"), "passthrough");
	assert.equal(classifyCommand("npm run 'test:unit'"), "diagnostic");
});
