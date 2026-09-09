# Changelog — pi-multi-pass

All notable changes to the `pi-multi-pass` extension are documented here.

## [Unreleased] - 2026-09-09

### Feat: Antigravity Multi-Subscription Support & Smarter Pool Failover

- Added first-class `antigravity` provider registration with OAuth login, refresh, API key resolution, live model catalog, and streaming integration.
- Kept `google-antigravity` as a legacy alias while preferring the new `antigravity` provider name.
- Registered the Antigravity API with Pi compatibility provider hooks so multi-subscription routing can use Antigravity models directly.
- Added Codex OAuth token metadata fallback from `chatgpt_account_id` to `user_id` for personal/free ChatGPT accounts.
- Expanded provider retry classification for overloads, 5xx errors, network failures, Cloudflare 524s, insufficient quota, usage limits, and budget errors.
- Prevented replay loops by distinguishing retryable infrastructure errors from non-retryable account/quota/billing limits.
- Improved pool failover follow-up replay so a captured prompt or safe `continue` fallback is submitted when Pi will not retry the failed turn.
- Added runtime failover test coverage for retryable and non-retryable provider error cases.
