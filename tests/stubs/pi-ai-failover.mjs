const modelDefaults = {
	name: "Fake model",
	api: "fake",
	baseUrl: "http://fake.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const models = {
	anthropic: [{ ...modelDefaults, id: "claude-opus-5" }],
	"openai-codex": [{ ...modelDefaults, id: "gpt-5.6-sol" }],
};

export function getModels(provider) {
	return models[provider] ?? [];
}
