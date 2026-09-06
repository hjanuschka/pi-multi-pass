import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "extensions", "multi-sub.ts"), "utf8");
assert.match(source, /const MAX_ROUTING_TRACE_ENTRIES = 100/);
assert.match(source, /this\.recordTrace\(`selected \$\{nextCandidate\.provider\}/);
assert.match(source, /this\.recordTrace\(skip\.detail\)/);

const agentDir = mkdtempSync(join(tmpdir(), "pi-multi-pass-trace-"));

try {
	writeFileSync(
		join(agentDir, "multi-pass.json"),
		JSON.stringify({ subscriptions: [], pools: [], chains: [], presets: [] }),
	);

	const commands = [
		["initial", "/pool trace status"],
		["start", "/pool trace start"],
		["active", "/pool trace status"],
		["stop", "/pool trace stop"],
		["stopped", "/pool trace status"],
	].map(([id, message]) => JSON.stringify({ id, type: "prompt", message })).join("\n");

	const result = spawnSync(
		"pi",
		[
			"--mode", "rpc",
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--extension", join(root, "extensions", "multi-sub.ts"),
		],
		{
			cwd: root,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			input: `${commands}\n`,
			encoding: "utf8",
			timeout: 15_000,
		},
	);

	assert.equal(result.error, undefined, result.error?.message);
	assert.equal(result.status, 0, result.stderr);
	assert.doesNotMatch(result.stdout, /"type":"extension_error"/, result.stdout);
	assert.match(result.stdout, /"message":"Routing trace: stopped, 0 entries"/);
	assert.match(result.stdout, /"message":"Routing trace started; previous entries cleared"/);
	assert.match(result.stdout, /"message":"Routing trace: recording, 0 entries"/);
	assert.match(result.stdout, /"message":"Routing trace stopped; recorded entries retained"/);
	console.log("routing trace checks passed");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}
