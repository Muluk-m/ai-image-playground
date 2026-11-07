# Errors

| `error.code` | Meaning | Action |
| --- | --- | --- |
| `AUTH_REQUIRED`, `UNAUTHENTICATED` | No valid CLI connection, or login code invalid/already used | Check `auth status` after a permission interruption; keep a ready connection, otherwise follow the login flow in SKILL.md |
| `SERVICE_MISMATCH` | `MUVLOOM_API_URL` names a different service than the stored connection; `details.api_url`, `details.connection_api_url` | Do not start a login. Unset `MUVLOOM_API_URL` to use the connection; use `auth login --switch-service` only if the user wants the other service |
| `AUTH_EXPIRED` | The server reports the login code expired | Start a new login flow |
| `AUTH_PENDING` | Browser approval not done yet | Keep waiting with `muvloom auth login`; ask the user to sign in and approve only if they have not yet been told |
| `AUTH_DENIED` | User denied in the browser | Stop unless the user wants to retry |
| `CREDENTIAL_STORE_UNWRITABLE` | The CLI cannot write its credential store (config directory or keychain). Login stops before the code is redeemed; a login already approved stays resumable | Tell the user the muvloom config directory must be writable (or set `MUVLOOM_CONFIG_DIR` to a writable one), then run the same `muvloom auth login` again; do not start a new approval |
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
