# Errors

| `error.code` | Meaning | Action |
| --- | --- | --- |
| `AUTH_REQUIRED`, `UNAUTHENTICATED`, `AUTH_EXPIRED` | No valid CLI connection | Run the login flow from SKILL.md |
| `AUTH_PENDING` | Browser approval not done yet | Keep waiting with `muvloom auth login`; ask the user to sign in and approve only if they have not yet been told |
| `AUTH_DENIED` | User denied in the browser | Stop unless the user wants to retry |
| `PLAN_REQUIRED` | The request (e.g. 4K) needs an active membership | Offer a smaller image size, or tell the user membership is required |
| `INSUFFICIENT_CREDITS` | Not enough credits; `details.required`, `details.available` | Tell the user; do not retry |
| `MAX_CREDITS_EXCEEDED` | Quote above `--max-credits`; `details.required` | Report that the user's explicit credit limit was exceeded and stop; keep the limit |
| `IDEMPOTENCY_CONFLICT` | Key reused with different parameters | Use a new key for a different request |
| `INVALID_REQUEST` | Bad prompt, model, ratio, size, quality or reference | Read `message`/`details.available`, fix, retry |
| `MODEL_UNAVAILABLE` | Model temporarily switched off | Refresh capabilities; use another available default only if the user did not explicitly require this model. Otherwise report the unavailable model |
| `NOT_FOUND` | Unknown or another account's id | Check the id |
| `JOB_FAILED` | The waited job ended without an image; `details.job.error` says why | For confirmed terminal failures with code `rate_limited`, `upstream_timeout` or `interrupted`, retry once after a short delay with the same request and a new idempotency key, preserving explicit limits. Report other failures; never resubmit an unfinished or canceled job |
| `JOB_CANCELED` | The waited job was canceled | Report it |
| `FILE_EXISTS` | Download target exists | Choose another `--output`; never delete user files to make room |
| `RATE_LIMITED`, `NETWORK_ERROR`, `TEMPORARILY_UNAVAILABLE`, `INTERNAL_ERROR` | Temporary | Retry the failed operation once after a short delay. For create, recover/reuse the same idempotency key; for wait or download, retry that operation on the existing job/artifact |
| `CAPABILITY_UNAVAILABLE` | CLI access is not enabled on this server | Report it |
| `UNSUPPORTED_VERSION`, `UPGRADE_REQUIRED` | CLI too old | Upgrade with install.md |
