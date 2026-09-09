# Lessons Learned — pi-multi-pass

## 2026-09-09 — Provider Pools, Codex Accounts, and Antigravity

- ChatGPT/Codex OAuth tokens for personal/free accounts can omit `chatgpt_account_id`. Always fall back to `user_id` when extracting account metadata for `chatgpt-account-id`.
- Treat quota, budget, billing, and usage-limit errors as non-retryable provider/account limits. Replaying the same turn through Pi retry can loop unless the pool extension explicitly rotates providers and submits a follow-up.
- Treat 5xx, 429, overload, timeout, connection reset, and Cloudflare 524 errors as retryable infrastructure/provider errors.
- Respect Pi global retry settings (`settings.retry.enabled === false`) before assuming Pi will retry a turn.
- When a model provider is not part of `@earendil-works/pi-ai/providers/all`, register it explicitly with `registerApiProvider` and supply the provider-specific API and stream handlers.
- Preserve legacy provider aliases (`google-antigravity`) while adding cleaner names (`antigravity`) to avoid breaking existing user configs.
- For failover replay, if the original user prompt is unavailable, submit a safe `continue` follow-up instead of silently dropping the turn.
