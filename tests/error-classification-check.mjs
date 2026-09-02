/**
 * Does a provider error that means "this account is finished" actually trigger
 * failover?
 *
 * `PoolManager.handleError` returns false on its second line when
 * `isRateLimitError` says no, and then no pool member and no chain entry is
 * ever considered. So this predicate, eight regexes long, is the gate in front
 * of the entire failover engine.
 *
 * The check reads RATE_LIMIT_PATTERNS out of extensions/multi-sub.ts rather
 * than restating it. A copy of the list in this file would keep passing after
 * someone deleted a pattern from the source, which is the only failure this
 * test exists to catch.
 *
 *   node tests/error-classification-check.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "extensions", "multi-sub.ts");

/** Pull the real array out of the extension source and turn it into RegExps. */
function loadPatterns() {
	const src = readFileSync(SOURCE, "utf8");
	const start = src.indexOf("const RATE_LIMIT_PATTERNS = [");
	assert.notEqual(start, -1, "RATE_LIMIT_PATTERNS not found in extensions/multi-sub.ts");
	const end = src.indexOf("];", start);
	assert.notEqual(end, -1, "RATE_LIMIT_PATTERNS array is not terminated");
	const body = src.slice(start + "const RATE_LIMIT_PATTERNS = [".length, end);

	const patterns = [];
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("//")) continue;
		const match = trimmed.match(/^\/(.*)\/([a-z]*),$/);
		assert.ok(match, `unparsed line in RATE_LIMIT_PATTERNS: ${trimmed}`);
		patterns.push(new RegExp(match[1], match[2]));
	}
	assert.ok(patterns.length >= 8, `expected at least 8 patterns, parsed ${patterns.length}`);
	return patterns;
}

const patterns = loadPatterns();
const isRateLimitError = (message) => patterns.some((p) => p.test(message));

/**
 * Real strings, copied verbatim from provider responses. Anything here that
 * returns false is a session that dies with a live account one hop away.
 */
const MUST_FAIL_OVER = [
	// Anthropic subscription exhaustion. HTTP 400, invalid_request_error.
	// Observed 2026-09-02, `anthropic` account, opus and sonnet alike. This is
	// the string the original eight patterns all missed.
	"400 invalid_request_error: You're out of extra usage. Ask your workspace admin to add more so you can keep going.",
	"You're out of extra usage",
	// Anthropic pay-as-you-go with an empty balance.
	"Your credit balance is too low to access the Anthropic API",
	// The classic cases, which must keep working.
	"429 rate_limit_error",
	"You have exceeded your usage limit for this model",
	"Rate limit reached for requests",
	"Too Many Requests",
	"insufficient_quota: You exceeded your current quota",
	"The server is overloaded, please try again later",
];

/**
 * Errors that must NOT rotate the account. Rotating on these burns a second
 * account on a request that would fail identically everywhere, and hides the
 * real cause behind a provider switch.
 */
const MUST_NOT_FAIL_OVER = [
	"400 invalid_request_error: model claude-opus-9 not found",
	"401 authentication_error: OAuth token expired",
	"ENOENT: no such file or directory, open '/tmp/nope'",
	"AbortError: The operation was aborted",
	"prompt is too long: 250000 tokens > 200000 maximum",
];

let failures = 0;
for (const message of MUST_FAIL_OVER) {
	if (!isRateLimitError(message)) {
		console.error(`FAIL should fail over, did not: ${JSON.stringify(message)}`);
		failures++;
	}
}
for (const message of MUST_NOT_FAIL_OVER) {
	if (isRateLimitError(message)) {
		console.error(`FAIL should not fail over, did: ${JSON.stringify(message)}`);
		failures++;
	}
}

assert.equal(failures, 0, `${failures} error-classification case(s) failed`);
console.log(
	`error classification checks passed (${patterns.length} patterns, ` +
		`${MUST_FAIL_OVER.length} rotate, ${MUST_NOT_FAIL_OVER.length} do-not-rotate)`,
);
