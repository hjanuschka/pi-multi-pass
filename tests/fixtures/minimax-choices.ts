import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import multiPass from "../../extensions/multi-sub.ts";
import { mergeCatalog } from "../../lib/model-choices.ts";

export default function (pi) {
	const commands = new Map();
	let selected;
	const overlays = {};
	for (const provider of ["minimax", "minimax-cn"]) {
		const builtin = getBuiltinModels(provider);
		const m3 = builtin.find((model) => model.id === "MiniMax-M3");
		const flash = {
			...m3, id: "MiniMax-M3.1-Flash", name: "MiniMax-M3.1-Flash",
			contextWindow: 1_000_000, maxTokens: 524_288,
			cost: { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 },
			compat: { forceAdaptiveThinking: true },
			thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" },
		};
		// Fixture metadata stands in for the host's remote catalog, not a new
		// production catalog (including the fixture-only cache-write value).
		overlays[provider] = { models: [flash, { ...m3, name: "Remote M3", contextWindow: 1_000_000 }] };
		const merged = mergeCatalog(builtin, overlays[provider].models);
		assert.equal(merged.find((item) => item.model.id === m3.id)?.origin, "remote");
		assert.equal(merged.find((item) => item.model.id === "MiniMax-M2.7")?.origin, "builtin");
	}
	writeFileSync(join(getAgentDir(), "models-store.json"), JSON.stringify(overlays));
	multiPass({
		...pi,
		registerCommand(name, command) { commands.set(name, command); pi.registerCommand(name, command); },
		async setModel(model) { selected = model; return pi.setModel(model); },
	});
	pi.registerCommand("check-minimax-choices", {
		description: "Offline production extension regression checks",
		handler: async (_args, ctx) => Promise.resolve().then(async () => {
			const registry = ctx.modelRegistry;
			writeFileSync(join(getAgentDir(), "models-store.json"), JSON.stringify(overlays));
			await registry.refresh({ allowNetwork: false, providers: ["minimax-2", "minimax-cn-2", "minimax-cn-3"] });
			const quiet = { notify() {}, setStatus() {} };
			const context = (extra = {}) => ({ ...ctx, hasUI: false, model: undefined, ui: quiet, ...extra });
			const run = (name, args, extra = {}) => commands.get(name).handler(args, context(extra));
			const requests = [];
			const fetch = async (url, init) => {
				assert.match(String(url), /^https:\/\/api\.(minimax\.io|minimaxi\.com)\/anthropic\/v1\/messages$/);
				requests.push({ url: String(url), body: JSON.parse(init.body) });
				const events = [
					{ type: "message_start", message: { id: "offline", type: "message", role: "assistant", model: requests.at(-1).body.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
					{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				];
				return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
			};
			const conversation = { messages: [{ role: "user", content: [
				{ type: "text", text: "Describe this test image." },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			], timestamp: 1 }] };
			for (const provider of ["minimax-2", "minimax-cn-2"]) {
				// Registered models and refreshed metadata remain complete.
				assert.ok(registry.find(provider, "MiniMax-M2.7"));
				assert.equal(registry.find(provider, "MiniMax-M3").contextWindow, 1_000_000);
				const registration = registry.getRegisteredProviderConfig(provider);
				const mirrored = await registration.refreshModels();
				const flash = mirrored.find((model) => model.id === "MiniMax-M3.1-Flash");
				assert.deepEqual(flash.cost, overlays[provider.replace(/-2$/, "")].models[0].cost);
				assert.deepEqual(flash.compat, overlays[provider.replace(/-2$/, "")].models[0].compat);
				await run("subs", `switch ${provider}`);
				assert.equal(selected.id, "MiniMax-M3.1-Flash");
				assert.equal(selected.provider, provider);
				// The selected production model goes through Pi's real SDK transport.
				for (const reasoning of [undefined, "low", "medium", "high", "xhigh"]) {
					const result = await registry.getProvider(provider).streamSimple(selected, conversation, {
						apiKey: "offline-test-key", fetch, reasoning, maxTokens: 128,
					}).result();
					assert.notEqual(result.stopReason, "error", result.errorMessage);
					const request = requests.at(-1);
					assert.equal(request.body.model, "MiniMax-M3.1-Flash");
					assert.ok(request.url.includes(provider.includes("-cn-") ? "api.minimaxi.com" : "api.minimax.io"));
					assert.notEqual(request.body.thinking?.type, "disabled");
					assert.equal(request.body.service_tier, undefined);
					assert.equal(request.body.output_config?.effort, reasoning);
					assert.equal(request.body.messages[0].content[1].source.data, "aGVsbG8=");
				}
				const continued = await registry.getProvider(provider).streamSimple(selected, {
					messages: [...conversation.messages, {
						role: "assistant", api: "anthropic-messages", provider, model: selected.id,
						content: [{ type: "thinking", thinking: "Keep the signed reasoning block.", thinkingSignature: "offline-signature" },
							{ type: "toolCall", id: "tool_1", name: "lookup", arguments: { query: "test" } }],
						stopReason: "toolUse", timestamp: 2,
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					}, { role: "toolResult", toolCallId: "tool_1", toolName: "lookup", content: [{ type: "text", text: "result" }], isError: false, timestamp: 3 }],
					tools: [{ name: "lookup", description: "Look up a test value", parameters: { type: "object", properties: { query: { type: "string" } } } }],
				}, { apiKey: "offline-test-key", fetch, reasoning: "high", maxTokens: 128 }).result();
				assert.notEqual(continued.stopReason, "error", continued.errorMessage);
				const continuation = requests.at(-1).body;
				assert.ok(continuation.messages[1].content.some((block) => block.type === "thinking" && block.signature === "offline-signature"));
				assert.ok(continuation.messages[1].content.some((block) => block.type === "tool_use" && block.input.query === "test"));
				assert.ok(continuation.messages[2].content.some((block) => block.type === "tool_result"));
				await run("subs", `switch ${provider}`, { model: { ...registry.find(provider, "MiniMax-M3"), provider: "other-account" } });
				assert.equal(selected.id, "MiniMax-M3");
				await registry.complete(selected, conversation, { fetch, maxTokens: 128 });
				assert.equal(requests.at(-1).body.model, "MiniMax-M3");
				await run("subs", `switch ${provider}`, { model: registry.find(provider, "MiniMax-M2.7") });
				// Already-selected paths may skip setModel; assert the preferred ID
				// by switching from the other account with the same explicit ID.
				await run("subs", `switch ${provider}`, { model: { ...registry.find(provider, "MiniMax-M2.7"), provider: "other-account" } });
				assert.equal(selected.id, "MiniMax-M2.7");
				await registry.complete(selected, { messages: [{ role: "user", content: "legacy", timestamp: 1 }] }, { fetch, maxTokens: 128 });
				assert.equal(requests.at(-1).body.model, "MiniMax-M2.7");
			}
			const picker = async (model) => {
				let options;
				await run("subs", "model", { model, ui: { ...quiet, async select(_title, choices) { options = choices; } } });
				return options;
			};
			let choices = await picker();
			const global = choices.filter((line) => line.includes("(Global) #2"));
			assert.deepEqual(global.map((line) => line.split(" -- ")[0]), ["MiniMax-M3.1-Flash", "MiniMax-M3"]);
			assert.ok(choices.some((line) => line.startsWith("MiniMax-M2.7 --") && line.includes("(China) #3")), "same-ID models.json override must remain visible");
			choices = await picker(registry.find("minimax-2", "MiniMax-M2.7"));
			assert.ok(choices[0].startsWith("MiniMax-M2.7 --"), "current legacy selection must remain visible");
			selected = undefined;
			await run("mp-preset", "activate legacy");
			assert.equal(selected.id, "MiniMax-M2.7");
			await registry.complete(selected, { messages: [{ role: "user", content: "saved preset", timestamp: 1 }] }, { fetch, maxTokens: 128 });
			assert.equal(requests.at(-1).body.model, "MiniMax-M2.7");
			let presetModels;
			await run("mp-preset", "create", { ui: { ...quiet,
				async input() { return "new-preset"; },
				async select(title, options) {
					if (presetModels) return undefined;
					if (title.startsWith("Add entry")) return options.find((value) => value.startsWith("minimax-2 --"));
					presetModels = options;
				},
			} });
			assert.deepEqual(presetModels, ["MiniMax-M3.1-Flash", "MiniMax-M3"]);
			let poolModels;
			await run("pool", "chain create", { ui: { ...quiet,
				async input() { return "new-chain"; },
				async select(title, options) {
					if (title.startsWith("Default model")) { poolModels = options; return "MiniMax-M3.1-Flash"; }
					if (poolModels) return options.find((value) => value.includes("Done - save chain"));
					return options.find((value) => value.startsWith("global --"));
				},
				async confirm() { return true; },
			} });
			assert.deepEqual(poolModels, ["MiniMax-M3.1-Flash", "MiniMax-M3"]);
			const saved = JSON.parse(readFileSync(join(getAgentDir(), "multi-pass.json"), "utf8"));
			assert.equal(saved.chains.find((chain) => chain.name === "legacy").entries[0].model, "MiniMax-M2.7");
			assert.equal(saved.chains.find((chain) => chain.name === "new-chain").entries[0].model, "MiniMax-M3.1-Flash");
			let chainStatus;
			await run("pool", "chain status", { ui: { ...quiet, async select(_title, options) { chainStatus = options.join("\n"); } } });
			assert.doesNotMatch(chainStatus, /invalid model.*MiniMax-M2\.7/);
			// Missing Flash in an older host catalog is not permission to invent its metadata.
			writeFileSync(join(getAgentDir(), "models-store.json"), "{}");
			await registry.refresh({ allowNetwork: false, providers: ["minimax-2", "minimax-cn-2"] });
			await run("subs", "switch minimax-2");
			assert.equal(selected.id, "MiniMax-M3");
			// A host extension can replace a registered model with byte-identical
			// metadata. The registration layer, not a flattened tag, establishes intent.
			const existing = registry.getRegisteredProviderConfig("minimax-2");
			registry.registerProvider("minimax-2", { ...existing, models: existing.models.map((model) => ({ ...model })) });
			await registry.refresh({ allowNetwork: false });
			choices = await picker();
			assert.ok(choices.some((line) => line.startsWith("MiniMax-M2.7 --") && line.includes("(Global) #2")));
			await run("subs", "switch minimax-cn-3", { model: { id: "MiniMax-M2.7", provider: "saved-custom" } });
			await registry.complete(selected, { messages: [{ role: "user", content: "explicit custom", timestamp: 1 }] }, { fetch, maxTokens: 128 });
			assert.equal(requests.at(-1).body.model, "MiniMax-M2.7");
			assert.ok(requests.at(-1).url.includes("api.minimaxi.com"));
			ctx.ui.notify("MiniMax production choices and request checks passed", "info");
		}).catch((error) => {
			console.error(`MiniMax check failed: ${error.stack}`);
			ctx.ui.notify(`MiniMax check failed: ${error.stack}`, "error");
		}),
	});
}
