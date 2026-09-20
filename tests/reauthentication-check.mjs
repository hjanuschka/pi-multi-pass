import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(
	fileURLToPath(new URL("../extensions/multi-sub.ts", import.meta.url)),
	"utf8",
);

assert.match(source, /function isTerminalOAuthRefreshError\(errorMessage: string\)/);
assert.match(source, /providersRequiringReauthentication\.add\(providerName\)/);
assert.match(source, /\[reauthentication required\]/);
assert.match(
	source,
	/return !authStorage\.hasAuth\(name\) \|\| authStorage\.get\(name\)\?\.type === "oauth";/,
);
assert.match(source, /label: "re-authenticate"/);
assert.match(source, /await authStorage\.logout\(selectedProviderName\)/);
assert.match(source, /needs reauthentication\. Run \/subs login/);

const terminalRefreshPatterns = [
	/invalid[_\s-]?refresh[_\s-]?token/i,
	/refresh token.*(?:invalid|expired|revoked)/i,
	/(?:invalid|expired|revoked).*refresh token/i,
];
const isTerminalRefreshError = (message) =>
	terminalRefreshPatterns.some((pattern) => pattern.test(message));

assert.equal(
	isTerminalRefreshError("OpenAI Codex token refresh failed (401): invalid_refresh_token"),
	true,
);
assert.equal(isTerminalRefreshError("OAuth refresh token was revoked"), true);
assert.equal(isTerminalRefreshError("429: rate limit exceeded"), false);
assert.equal(isTerminalRefreshError("401: access token expired"), false);

console.log("reauthentication checks passed");
