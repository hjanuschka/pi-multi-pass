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
const mergeStatusBarQuota = new Function(
  `${extractFunction("mergeStatusBarQuota")}\nreturn mergeStatusBarQuota;`,
)();

const good = (provider, percent) => ({
  account: { providerName: provider },
  kind: "ready",
  worstRemainingPercent: percent,
});
const error = (provider) => ({ account: { providerName: provider }, kind: "error" });
const asMap = (entries) => new Map(entries);

// Fresh good results replace previous values.
{
  const { entries, allFailed } = mergeStatusBarQuota(
    asMap([["anthropic", good("anthropic", 20)]]),
    [good("anthropic", 63)],
  );
  assert.equal(asMap(entries).get("anthropic").worstRemainingPercent, 63);
  assert.equal(allFailed, false);
}

// An error result keeps the last good value instead of degrading to `?`.
{
  const prev = good("anthropic", 63);
  const { entries, allFailed } = mergeStatusBarQuota(asMap([["anthropic", prev]]), [
    error("anthropic"),
  ]);
  assert.equal(asMap(entries).get("anthropic"), prev);
  assert.equal(allFailed, true);
}

// An error with no previous good value stays an error.
{
  const { entries, allFailed } = mergeStatusBarQuota(asMap([]), [error("anthropic")]);
  assert.equal(asMap(entries).get("anthropic").kind, "error");
  assert.equal(allFailed, true);
}

// A previous error result (no percentage) does not shadow a new error either.
{
  const { entries } = mergeStatusBarQuota(asMap([["anthropic", error("anthropic")]]), [
    error("anthropic"),
  ]);
  assert.equal(asMap(entries).get("anthropic").kind, "error");
}

// One healthy account resets the failure streak even if another errors.
{
  const { allFailed } = mergeStatusBarQuota(asMap([]), [
    error("anthropic"),
    good("openai", 80),
  ]);
  assert.equal(allFailed, false);
}

// No results at all (nothing logged in) is not a failure.
{
  const { allFailed } = mergeStatusBarQuota(asMap([]), []);
  assert.equal(allFailed, false);
}

// The refresh path must actually use the helper and a fetch timeout.
assert.match(source, /mergeStatusBarQuota\(statusBarQuota, results\)/);
assert.match(source, /AbortSignal\.timeout\(STATUS_BAR_QUOTA_TIMEOUT_MS\)/);

console.log("status bar quota retention check passed");
