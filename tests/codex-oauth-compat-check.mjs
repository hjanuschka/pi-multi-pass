import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createOAuthInteraction,
  toOAuthCredential,
} from "../src/oauth-compat.mts";

function callbacks(overrides = {}) {
  return {
    onAuth() {},
    onDeviceCode() {},
    async onPrompt() { return "prompt-result"; },
    async onSelect() { return "browser"; },
    ...overrides,
  };
}

const source = readFileSync(new URL("../extensions/multi-sub.ts", import.meta.url), "utf8");
assert.doesNotMatch(
  source,
  /\b(?:loginOpenAICodex|refreshOpenAICodexToken)\b/,
  "Codex must not call runtime functions removed from @earendil-works/pi-ai/oauth",
);
assert.match(source, /from "@earendil-works\/pi-ai\/providers\/all"/);
assert.match(source, /id === "openai-codex"/);

const events = [];
const interaction = createOAuthInteraction(callbacks({
  onAuth: (event) => events.push(["auth", event]),
  onDeviceCode: (event) => events.push(["device", event]),
  onProgress: (message) => events.push(["progress", message]),
  onSelect: async (prompt) => {
    assert.deepEqual(prompt, {
      message: "Choose",
      options: [{ id: "browser", label: "Browser login" }],
    });
    return "browser";
  },
}));

interaction.notify({ type: "auth_url", url: "https://example.test", instructions: "Sign in" });
interaction.notify({
  type: "device_code",
  userCode: "ABCD-EFGH",
  verificationUri: "https://example.test/device",
  intervalSeconds: 5,
  expiresInSeconds: 900,
});
interaction.notify({ type: "progress", message: "Waiting" });
interaction.notify({ type: "info", message: "Ready" });
assert.deepEqual(events, [
  ["auth", { url: "https://example.test", instructions: "Sign in" }],
  ["device", {
    userCode: "ABCD-EFGH",
    verificationUri: "https://example.test/device",
    intervalSeconds: 5,
    expiresInSeconds: 900,
  }],
  ["progress", "Waiting"],
  ["progress", "Ready"],
]);
assert.equal(await interaction.prompt({
  type: "select",
  message: "Choose",
  options: [{ id: "browser", label: "Browser login", description: "Default" }],
}), "browser");

const cancelledSelection = createOAuthInteraction(callbacks({ onSelect: async () => undefined }));
await assert.rejects(
  cancelledSelection.prompt({ type: "select", message: "Choose", options: [] }),
  /OAuth selection cancelled/,
);

let manualPromptStarted = false;
const promptAbort = new AbortController();
const pendingManualPrompt = createOAuthInteraction(callbacks({
  onManualCodeInput: () => {
    manualPromptStarted = true;
    return new Promise(() => {});
  },
})).prompt({
  type: "manual_code",
  message: "Paste redirect URL",
  signal: promptAbort.signal,
});
assert.equal(manualPromptStarted, true);
const abortReason = new Error("callback server completed");
promptAbort.abort(abortReason);
await assert.rejects(pendingManualPrompt, (error) => error === abortReason);

const alreadyAborted = new AbortController();
alreadyAborted.abort(abortReason);
let abortedPromptStarted = false;
await assert.rejects(
  createOAuthInteraction(callbacks({
    onManualCodeInput: async () => {
      abortedPromptStarted = true;
      return "unused";
    },
  })).prompt({
    type: "manual_code",
    message: "Paste redirect URL",
    signal: alreadyAborted.signal,
  }),
  (error) => error === abortReason,
);
assert.equal(abortedPromptStarted, false);

const synchronousAbort = new AbortController();
const synchronousAbortReason = new Error("callback completed synchronously");
await assert.rejects(
  createOAuthInteraction(callbacks({
    onManualCodeInput: () => {
      synchronousAbort.abort(synchronousAbortReason);
      return new Promise(() => {});
    },
  })).prompt({
    type: "manual_code",
    message: "Paste redirect URL",
    signal: synchronousAbort.signal,
  }),
  (error) => error === synchronousAbortReason,
);

assert.deepEqual(
  toOAuthCredential({
    access: "access-token",
    refresh: "refresh-token",
    expires: 123,
    accountId: "account-1",
  }),
  {
    type: "oauth",
    access: "access-token",
    refresh: "refresh-token",
    expires: 123,
    accountId: "account-1",
  },
);

console.log("codex OAuth compatibility checks passed");
