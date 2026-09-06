import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "pi-multi-pass-auth-"));

try {
	writeFileSync(
		join(agentDir, "multi-pass.json"),
		JSON.stringify({
			subscriptions: [{ provider: "openai-codex", index: 2 }],
			pools: [],
			chains: [],
			presets: [],
		}),
	);
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({
			"openai-codex-2": {
				type: "oauth",
				access: "test-access",
				refresh: "test-refresh",
				expires: Date.now() + 60_000,
				accountId: "test-account",
			},
		}),
	);

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
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			input: '{"id":"auth-compat","type":"prompt","message":"/subs status"}\n',
			encoding: "utf8",
			timeout: 15_000,
		},
	);

	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stdout, /"type":"extension_error"/, result.stdout);
	assert.match(
		result.stdout,
		/"id":"auth-compat","type":"response","command":"prompt","success":true/,
	);
	console.log("auth compatibility check passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
