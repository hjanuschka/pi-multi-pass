import assert from "node:assert/strict";
import { loginSubscription } from "../extensions/multi-sub.ts";

const notifications = [];
const opened = [];
const pi = {
  async exec(command, args) {
    opened.push({ command, args });
    return { code: 0, stdout: "", stderr: "" };
  },
};
let refreshed = 0;
let loginCall;
const ctx = {
  modelRegistry: {
    runtime: {
      async login(providerName, type, interaction) {
        loginCall = { providerName, type };
        const selected = await interaction.prompt({
          type: "select",
          message: "Choose login method",
          options: [
            { id: "cached", label: "Kiro login" },
            { id: "fresh", label: "Kiro login" },
          ],
        });
        assert.equal(selected, "fresh");
        interaction.notify({
          type: "auth_url",
          url: "https://example.com/login",
          instructions: "Authenticate in your browser.",
        });
      },
    },
    refresh() {
      refreshed += 1;
    },
  },
  ui: {
    async select(_title, options) {
      return options[1];
    },
    async input() {
      return undefined;
    },
    notify(message, type) {
      notifications.push({ message, type });
    },
  },
};

await loginSubscription(pi, ctx, "kiro-2", "Kiro #2");
assert.deepEqual(loginCall, { providerName: "kiro-2", type: "oauth" });
assert.equal(refreshed, 1);
assert.ok(notifications.some(({ message }) => message.includes("https://example.com/login")));
assert.ok(notifications.some(({ message }) => message === "Logged in to Kiro #2"));
assert.equal(opened.length, 1);
assert.ok(opened[0].args.includes("https://example.com/login"));


let secretInputShown = false;
const secretNotifications = [];
await loginSubscription(pi, {
  modelRegistry: {
    runtime: {
      async login(_providerName, _type, interaction) {
        await interaction.prompt({ type: "secret", message: "Enter secret" });
      },
    },
    refresh() {},
  },
  ui: {
    async select() {
      return undefined;
    },
    async input() {
      secretInputShown = true;
      return "exposed";
    },
    notify(message, type) {
      secretNotifications.push({ message, type });
    },
  },
}, "kiro-3", "Kiro #3");
assert.equal(secretInputShown, false);
assert.ok(secretNotifications.some(({ message, type }) => type === "error" && message.includes("secure prompt")));

console.log("subs login checks passed");
