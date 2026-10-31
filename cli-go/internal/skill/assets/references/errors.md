# Errors

| `error.code` | Meaning | Action |
| --- | --- | --- |
| `AUTH_REQUIRED`, `UNAUTHENTICATED`, `AUTH_EXPIRED` | No valid CLI connection | Run the login flow from SKILL.md |
| `AUTH_PENDING` | Browser approval not done yet | Remind the user, then `muvloom auth login` again |
| `AUTH_DENIED` | User denied in the browser | Stop unless the user wants to retry |
| `PLAN_REQUIRED` | The request (e.g. 4K) needs an active membership | Offer a smaller image size, or tell the user membership is required |
| `INSUFFICIENT_CREDITS` | Not enough credits; `details.required`, `details.available` | Tell the user; do not retry |
| `MAX_CREDITS_EXCEEDED` | Quote above `--max-credits`; `details.required` | Ask the user before raising the limit |
| `IDEMPOTENCY_CONFLICT` | Key reused with different parameters | Use a new key for a different request |
| `INVALID_REQUEST` | Bad prompt, model, ratio, size, quality or reference | Read `message`/`details.available`, fix, retry |
| `MODEL_UNAVAILABLE` | Model temporarily switched off | Pick another model from `capabilities` |
| `NOT_FOUND` | Unknown or another account's id | Check the id |
| `FILE_EXISTS` | Download target exists | Choose another `--output`; never delete user files to make room |
| `RATE_LIMITED`, `NETWORK_ERROR`, `TEMPORARILY_UNAVAILABLE`, `INTERNAL_ERROR` | Temporary | Wait, then retry with the same idempotency key |
| `CAPABILITY_UNAVAILABLE` | CLI access is not enabled on this server | Report it |
| `UNSUPPORTED_VERSION`, `UPGRADE_REQUIRED` | CLI too old | Upgrade with install.md |
