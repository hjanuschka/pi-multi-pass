# multi-pass

Multi-subscription extension for [pi](https://github.com/badlogic/pi-mono) -- use multiple OAuth accounts per provider.

If you have multiple ChatGPT, Claude, Copilot, or other subscription accounts, this extension lets you log in to all of them and switch between accounts via `/model`.

## Install

```bash
pi install git:github.com/hjanuschka/multi-pass
```

## Usage

### TUI command: `/subs`

Manage subscriptions interactively -- no env vars or config files needed.

```
/subs          Open the subscription manager menu
/subs add      Add a new subscription (pick provider, optional label)
/subs remove   Remove a subscription and logout
/subs login    Login to a subscription (directs to /login)
/subs logout   Logout from a subscription
/subs list     List all extra subscriptions with auth status
/subs status   Show detailed status (token expiry, model count, source)
```

#### Adding a subscription

1. `/subs add`
2. Pick a provider (e.g., `openai-codex`)
3. Optionally add a label (e.g., "work", "personal")
4. Choose to login now or later
5. Complete the OAuth flow via `/login`
6. Models appear in `/model` as "GPT-5.2 (#2)", "Claude Sonnet 4.5 (#2)", etc.

### Environment variable (alternative)

For scripting or CI, set `MULTI_SUB`:

```bash
export MULTI_SUB="openai-codex:2,anthropic:1"
```

This creates `openai-codex-2`, `openai-codex-3`, and `anthropic-2`. Env-based entries are merged with saved config (no duplicates).

## Supported providers

| Provider key | Service | Login flow |
|---|---|---|
| `anthropic` | Claude Pro/Max | Browser + paste code |
| `openai-codex` | ChatGPT Plus/Pro (Codex) | Browser + local callback |
| `github-copilot` | GitHub Copilot | Device code flow |
| `google-gemini-cli` | Google Cloud Code Assist | Browser + local callback |
| `google-antigravity` | Antigravity (Gemini 3, Claude, GPT-OSS) | Browser + local callback |

## How it works

- Subscriptions are saved in `~/.pi/agent/multi-pass.json`
- Each extra subscription registers a new provider (e.g., `anthropic-2`) with its own OAuth flow and auth token
- Models are cloned dynamically from the built-in provider via `getModels()`, so new models from pi updates appear automatically
- Reuses the built-in OAuth login/refresh functions and API stream handlers
- GitHub Copilot's dynamic base URL (`modifyModels`) is handled correctly
- `MULTI_SUB` env var entries are merged additively with saved config

## Config file

`~/.pi/agent/multi-pass.json`:

```json
{
  "subscriptions": [
    { "provider": "openai-codex", "index": 2, "label": "work" },
    { "provider": "openai-codex", "index": 3, "label": "personal" },
    { "provider": "anthropic", "index": 2 }
  ]
}
```

You can edit this file directly. Changes take effect on next pi startup or `/reload`.

## Example

```
/subs add
> Select provider: openai-codex -- ChatGPT Plus/Pro (Codex)
> Label: work
> Created ChatGPT Codex #2 (work). Login now? Yes
> Use /login and select "ChatGPT Codex #2" to authenticate.

/subs status
> ChatGPT Codex #2 (work) | logged in (token expires in 47m) | 8 models | saved
> Anthropic #2             | not logged in                    | 23 models | env
```

## License

MIT
