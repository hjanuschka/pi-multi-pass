import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = mkdtempSync(join(tmpdir(), "pi-multi-pass-choices-"));
try {
	const auth = {};
	for (const provider of ["minimax", "minimax-cn", "minimax-2", "minimax-cn-2", "minimax-cn-3"]) {
		auth[provider] = { type: "api_key", key: "offline-test-key" };
	}
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify(auth));
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
		"minimax-cn-3": { modelOverrides: { "MiniMax-M2.7": { contextWindow: 204800 } } },
	} }));
	writeFileSync(join(agentDir, "multi-pass.json"), JSON.stringify({
		subscriptions: [
			{ provider: "minimax", index: 2 },
			{ provider: "minimax-cn", index: 2 },
			{ provider: "minimax-cn", index: 3 },
		],
		pools: [{ name: "global", baseProvider: "minimax", members: ["minimax-2"], enabled: true }],
		chains: [{ name: "legacy", entries: [{ pool: "global", model: "MiniMax-M2.7", enabled: true }], enabled: true }],
		presets: [{ name: "legacy", entries: [{ provider: "minimax-2", model: "MiniMax-M2.7", enabled: true }], enabled: true }],
	}));
	const child = spawn("pi", [
		"--mode", "rpc", "--offline", "--no-extensions", "--no-skills",
		"--no-prompt-templates", "--no-context-files", "--extension",
		join(root, "tests", "fixtures", "minimax-choices.ts"),
	], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
	let stdout = "", stderr = "";
	const status = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => { child.kill(); reject(new Error(stdout + stderr)); }, 60_000);
		child.on("error", (error) => { clearTimeout(timer); reject(error); });
		let started = false;
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (process.env.DEBUG_MINIMAX_TEST) process.stderr.write(chunk);
			if (!started && stdout.includes('"id":"ready"')) {
				started = true;
				child.stdin.write('{"id":"check","type":"prompt","message":"/check-minimax-choices"}\n');
			}
			if (/MiniMax production choices and request checks passed|MiniMax check failed:|"success":false|"type":"extension_error"/.test(stdout)) child.stdin.end();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (process.env.DEBUG_MINIMAX_TEST) process.stderr.write(chunk);
			if (stderr.includes("MiniMax check failed:")) child.stdin.end();
		});
		child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
		child.stdin.write('{"id":"ready","type":"get_state"}\n');
	});
	assert.equal(status, 0, stderr);
	assert.doesNotMatch(stdout, /"type":"extension_error"/, stdout);
	assert.match(stdout, /MiniMax production choices and request checks passed/, stdout + stderr);
	console.log("MiniMax production choices and request checks passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
