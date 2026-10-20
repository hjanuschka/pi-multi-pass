import assert from "node:assert/strict";
import { configuredModelOverride, mergeCatalog, ordinaryModelChoices, matchesCatalogModel } from "../lib/model-choices.ts";

const model = (id, extra = {}) => ({ id, provider: "minimax", name: id, input: ["text"], ...extra });
const legacy = model("MiniMax-M2.7");
const flash = model("MiniMax-M3.1-Flash");
const m3 = model("MiniMax-M3", { input: ["text", "image"] });
const media = model("speech-02-hd", { input: ["audio"] });
const other = model("MiniMax-M2.7", { provider: "gateway" });
const custom = model("my-model");
const catalog = [legacy, m3, flash, media];
const all = [...catalog, other, custom];
assert.deepEqual(ordinaryModelChoices(all, (candidate) => catalog.includes(candidate)).map((m) => m.id),
	["MiniMax-M3.1-Flash", "MiniMax-M3", "speech-02-hd", "MiniMax-M2.7", "my-model"]);
assert.ok(ordinaryModelChoices(all, () => true, legacy).includes(legacy));
assert.ok(ordinaryModelChoices([legacy], () => false).includes(legacy));
assert.equal(configuredModelOverride({ providers: { minimax: { models: [legacy] } } }, "minimax", legacy.id), true);
assert.equal(configuredModelOverride({ providers: { minimax: { modelOverrides: { [legacy.id]: {} } } } }, "minimax", legacy.id), true);
assert.equal(configuredModelOverride({ providers: { minimax: { baseUrl: "https://custom.invalid" } } }, "minimax", legacy.id), true);
assert.equal(configuredModelOverride({ providers: { minimax: { apiKey: "offline-test-key" } } }, "minimax", legacy.id), false);
assert.equal(matchesCatalogModel(legacy, { ...legacy, name: "My legacy model" }), false);
assert.equal(matchesCatalogModel(legacy, { ...legacy, headers: undefined }), true);
const overlay = { ...m3, contextWindow: 1234 };
const merged = mergeCatalog(catalog, [overlay]);
assert.equal(merged.find((item) => item.model.id === m3.id).model, overlay);
assert.equal(merged.find((item) => item.model.id === m3.id).origin, "remote");
assert.equal(merged.find((item) => item.model.id === legacy.id).origin, "builtin");
assert.equal(merged.length, catalog.length);
console.log("Model choice provenance checks passed");
