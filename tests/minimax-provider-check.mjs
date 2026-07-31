import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("../extensions/multi-sub.ts", import.meta.url));
const source = await readFile(sourcePath, "utf8");

assert.match(source, /apiKey\?: string;/);
assert.match(source, /baseUrl\?: string;/);
assert.match(source, /modelIds\?: readonly string\[\];/);
assert.match(source, /const MINIMAX_MODEL_IDS = \["MiniMax-M3", "MiniMax-M2\.7"\]/);

for (const [provider, apiKey, endpoint] of [
  ["minimax", "$MINIMAX_API_KEY", "https://api.minimax.io/anthropic"],
  ["minimax-cn", "$MINIMAX_CN_API_KEY", "https://api.minimaxi.com/anthropic"],
]) {
  const providerPattern = provider === "minimax-cn"
    ? /"minimax-cn": \{([\s\S]*?)\n\t\},/
    : /\n\tminimax: \{([\s\S]*?)\n\t\},/;
  const match = source.match(providerPattern);
  assert.ok(match, `missing provider template: ${provider}`);
  assert.ok(match[1].includes(`apiKey: "${apiKey}"`));
  assert.ok(match[1].includes(`baseUrl: "${endpoint}"`));
  assert.match(match[1], /modelIds: MINIMAX_MODEL_IDS/);
  assert.match(match[1], /api: "anthropic-messages"/);
}

const registerStart = source.indexOf("function registerSub(");
const registerEnd = source.indexOf("\n// ==========================================================================\n// Pool rotation engine", registerStart);
assert.ok(registerStart >= 0 && registerEnd > registerStart, "registerSub body not found");
const registerBody = source.slice(registerStart, registerEnd);
assert.match(registerBody, /template\.baseUrl/);
assert.match(registerBody, /template\.modelIds/);
assert.match(registerBody, /apiKey: template\.apiKey/);
assert.match(registerBody, /buildOAuth\?\./);
assert.doesNotMatch(source, /buildOAuth\(entry\.index\)\.name/);

console.log("MiniMax provider checks passed");
