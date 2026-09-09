# Project Memory — pi-multi-pass

## 2026-09-09 Session Memory

- Added Antigravity provider support directly in `extensions/multi-sub.ts` using `pi-antigravity` auth, catalog, and streaming modules.
- The preferred provider key is now `antigravity`; `google-antigravity` remains as a compatibility alias.
- Codex token metadata extraction now supports personal/free ChatGPT accounts by falling back to `user_id` when `chatgpt_account_id` is empty.
- Pool failover logic now makes a clearer distinction between retryable service failures and non-retryable account/quota/billing limits.
- Runtime tests were updated in `tests/runtime-failover-check.mjs` to cover smarter failover/replay behavior.
