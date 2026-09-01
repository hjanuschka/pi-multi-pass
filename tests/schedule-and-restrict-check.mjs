/**
 * Regression tests for two silent-data-loss bugs in the pool editors.
 *
 * Both were found by driving the real TUI, and both were invisible to the rest
 * of this directory: pool-edit-check.mjs and project-restriction-check.mjs
 * re-implement the logic locally, so they passed while the shipped code was
 * wrong. These tests load extensions/multi-sub.ts itself.
 *
 * Bug 1 - schedule windows: input the parser could not read was discarded
 *   without a word. A "preferred" member with zero windows is ALWAYS active
 *   (getScheduledMemberState), so "09:00-18:00" produced a pool that looked
 *   scheduled and behaved unscheduled.
 *
 * Bug 2 - project restriction: the staged allow-list started empty instead of
 *   seeded from the saved config, and the editor saves on Escape as well as on
 *   [Done - save]. Opening the screen and backing out wiped the restriction and
 *   reported "Project restriction cleared. All subs available."
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const here = new URL(".", import.meta.url).pathname;
const extPath = join(here, "..", "extensions", "multi-sub.ts");

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	alias: {
		"@earendil-works/pi-coding-agent": join(here, "stubs", "coding-agent.mjs"),
		"@earendil-works/pi-ai/compat": join(here, "stubs", "pi-ai.mjs"),
		"@earendil-works/pi-ai/oauth": join(here, "stubs", "pi-ai.mjs"),
		"@earendil-works/pi-ai": join(here, "stubs", "pi-ai.mjs"),
		"@earendil-works/pi-tui": join(here, "stubs", "pi-tui.mjs"),
	},
});
process.env.MULTIPASS_TEST_AGENT_DIR = mkdtempSync(join(tmpdir(), "multipass-schedule-"));

const mod = await jiti.import(extPath, {});
const { parseScheduleWindowInput, initialAllowedSubs } = mod.__testHooks;
assert.ok(parseScheduleWindowInput, "__testHooks must export parseScheduleWindowInput");
assert.ok(initialAllowedSubs, "__testHooks must export initialAllowedSubs");

// --- bug 1: schedule window parsing --------------------------------------

// Bare hour ranges keep working, including the overnight case.
assert.deepEqual(parseScheduleWindowInput("9-17").hours, [9, 17]);
assert.deepEqual(parseScheduleWindowInput("22-6").hours, [22, 6]);

// Clock form is accepted - this is what a user actually types.
assert.deepEqual(
	parseScheduleWindowInput("09:00-18:00").hours,
	[9, 18],
	'"09:00-18:00" must parse as hours 9-18, not be silently dropped',
);
assert.deepEqual(parseScheduleWindowInput("9:00-17:00").hours, [9, 17]);

// Minutes cannot be represented in ScheduleWindow.hours, so a clock form with
// non-zero minutes must be REJECTED rather than truncated to a wrong window.
assert.equal(
	parseScheduleWindowInput("09:30-18:00"),
	null,
	"non-zero minutes must be rejected, never truncated to 9-18",
);
assert.equal(parseScheduleWindowInput("09:00-18:45"), null);

// Out-of-range hours are not a window.
assert.equal(parseScheduleWindowInput("9-25"), null);
assert.equal(parseScheduleWindowInput("30-40"), null);

// Days still work, alone and combined with hours.
assert.deepEqual(parseScheduleWindowInput("mon-fri").days, [
	"mon",
	"tue",
	"wed",
	"thu",
	"fri",
]);
const combined = parseScheduleWindowInput("9-17 mon-fri");
assert.deepEqual(combined.hours, [9, 17]);
assert.equal(combined.days.length, 5);
assert.deepEqual(parseScheduleWindowInput("sat").days, ["sat"]);

// Date ranges still work.
assert.deepEqual(parseScheduleWindowInput("2026-01-01..2026-01-31").dateRange, {
	from: "2026-01-01",
	to: "2026-01-31",
});

// Garbage yields null so the caller can warn instead of pretending it worked.
assert.equal(parseScheduleWindowInput("whenever"), null);
assert.equal(parseScheduleWindowInput("9h-17h"), null);
assert.equal(parseScheduleWindowInput(""), null);

// The caller must actually warn. Only promptPreferredMemberSchedule owns that
// path, so assert the shipped source warns on unparseable input rather than
// swallowing it, and that neither editor kept its own silent copy.
const source = await import("node:fs").then((fs) => fs.readFileSync(extPath, "utf-8"));
assert.match(
	source,
	/Could not read .* as a time window/,
	"unparseable window input must produce a user-visible warning",
);
const silentSchedule = source.match(/if \(window\) schedule\.windows = \[window\];/g) ?? [];
assert.deepEqual(
	silentSchedule,
	[],
	"schedule editors must go through promptPreferredMemberSchedule, not silently drop the parse result",
);

// --- bug 2: project restriction seeding ----------------------------------

const allProviders = ["anthropic", "anthropic-2", "openai-codex"];

// Saved restriction is staged, so [Done - save] / Escape re-saves it.
assert.deepEqual(
	initialAllowedSubs({ allowedSubs: ["anthropic"] }, allProviders),
	["anthropic"],
	"an existing restriction must be staged, not dropped on open",
);
assert.deepEqual(initialAllowedSubs({ allowedSubs: ["anthropic", "openai-codex"] }, allProviders), [
	"anthropic",
	"openai-codex",
]);

// No restriction stays no restriction.
assert.deepEqual(initialAllowedSubs(undefined, allProviders), []);
assert.deepEqual(initialAllowedSubs({}, allProviders), []);
assert.deepEqual(initialAllowedSubs({ allowedSubs: [] }, allProviders), []);

// A restriction naming a provider that no longer exists must not resurrect it.
assert.deepEqual(
	initialAllowedSubs({ allowedSubs: ["anthropic", "anthropic-9"] }, allProviders),
	["anthropic"],
	"stale provider names must be filtered out of the staged list",
);

// A correct helper the editor does not call fixes nothing, so pin the call site
// too. This is what the first draft of this test missed: reverting the editor to
// `const allowed: string[] = []` left every assertion above green.
assert.match(
	source,
	/const allowed: string\[\] = initialAllowedSubs\(projectConf, allProviderNames\);/,
	"the restriction editor must seed its staged list via initialAllowedSubs",
);
const emptyStaging = source.match(/const allowed: string\[\] = \[\];/g) ?? [];
assert.deepEqual(
	emptyStaging,
	[],
	"the restriction editor must not start staging from an empty list",
);

console.log("schedule-and-restrict-check: all assertions passed");
