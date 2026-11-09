import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../extensions/multi-sub.ts", import.meta.url)), "utf8");

// Compile the real helper out of multi-sub.ts so the test cannot drift from the shipped code.
function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found in multi-sub.ts`);
  const end = source.indexOf("\n}\n", start);
  return stripTypeScriptTypes(source.slice(start, end + 2));
}
const statusBarModelId = new Function(`${extractFunction("statusBarModelId")}\nreturn statusBarModelId;`)();

const virtual = { provider: "jev", id: "auto", api: "pi-virtual" };
const physical = { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages" };
const message = (model, extra = {}) => ({ type: "message", message: { role: "assistant", model, stopReason: "stop", ...extra } });
const user = { type: "message", message: { role: "user" } };
const ctx = (model, entries) => ({ model, sessionManager: { getBranch: () => entries } });

// A physical model keeps its own id, whatever the branch holds.
assert.equal(statusBarModelId(ctx(physical, [message("other")])), "claude-opus-5-5");
// No model selected.
assert.equal(statusBarModelId(ctx(undefined, [])), undefined);
// Virtual model before any response falls back to the virtual id.
assert.equal(statusBarModelId(ctx(virtual, [user])), "auto");
// Virtual model shows the physical model of the latest response.
assert.equal(statusBarModelId(ctx(virtual, [user, message("claude-sonnet-5-5"), user, message("gpt-6.1-sol")])), "gpt-6.1-sol");
// Failed and aborted responses are skipped.
assert.equal(
  statusBarModelId(ctx(virtual, [message("claude-sonnet-5-5"), message("gpt-6.1-sol", { stopReason: "error" }), message("kimi", { stopReason: "aborted" })])),
  "claude-sonnet-5-5",
);
// Non-message entries and assistant messages without a model are ignored.
assert.equal(statusBarModelId(ctx(virtual, [message("claude-sonnet-5-5"), { type: "custom" }, { type: "message", message: { role: "assistant" } }])), "claude-sonnet-5-5");

// The status bar must actually use the helper instead of ctx.model.id.
assert.match(source, /const modelId = statusBarModelId\(ctx\);/);
assert.doesNotMatch(source, /rightParts\.push\(ctx\.model\.id\)/);

console.log("status bar model check passed");
