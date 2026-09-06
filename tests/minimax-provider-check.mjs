import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "pi-multi-pass-minimax-"));

try {
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
		"minimax-2": { type: "api_key", key: "test-global" },
		"minimax-cn-2": { type: "api_key", key: "test-china" },
	}));

	const result = spawnSync(
		"pi",
		[
			"--mode",
			"rpc",
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--extension",
			join(root, "extensions", "multi-sub.ts"),
		],
		{
			cwd: root,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				MULTI_SUB: "minimax:1,minimax-cn:1",
			},
			input: '{"id":"models","type":"get_available_models"}\n',
			encoding: "utf8",
			timeout: 15_000,
		},
	);

	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stdout, /"type":"extension_error"/, result.stdout);

	const response = result.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.find((event) => event.id === "models");
	assert.equal(response?.success, true, result.stdout);

	const models = response.data.models;
	for (const [provider, baseUrl] of [
		["minimax-2", "https://api.minimax.io/anthropic"],
		["minimax-cn-2", "https://api.minimaxi.com/anthropic"],
	]) {
		const providerModels = models.filter((model) => model.provider === provider);
		assert.ok(providerModels.length > 0, `missing models for ${provider}`);
		assert.ok(providerModels.some((model) => model.id === "MiniMax-M3"));
		assert.ok(providerModels.some((model) => model.id === "MiniMax-M2.7-highspeed"));
		assert.ok(providerModels.every((model) => model.api === "anthropic-messages"));
		assert.ok(providerModels.every((model) => model.baseUrl === baseUrl));
	}

	console.log("MiniMax provider check passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
