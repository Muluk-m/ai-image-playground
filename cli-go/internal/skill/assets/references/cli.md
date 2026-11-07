# Commands

All commands print exactly one JSON line on stdout: `{"schema_version":1,"ok":true,"data":…}` or `{"schema_version":1,"ok":false,"error":{"code","message","details"}}`.

| Command | Purpose |
| --- | --- |
| `muvloom version` | CLI version and platform |
| `muvloom update check` | Daily cached stable-release check; `should_prompt` controls offering an authorized upgrade |
| `muvloom auth status` | `state`: ready / unauthenticated / outdated / unreachable / service_mismatch; the effective `api_url` and its `api_url_source` (environment / connection / pending_login / default); `credential_store` (keychain / file / none) and, when the keychain is wanted but unusable, `credential_store_issue` (unavailable / unsupported_platform); `leftover_temp_files` when an earlier version left `.tmp-*` files behind (`auth logout` removes them); account, credits, membership, installed Skill |
| `muvloom auth login [--no-wait] [--timeout S] [--switch-service]` | Opens the approval page in the browser itself and waits in the foreground; approving once finishes the login (the browser comes back to the CLI; device-code polling covers a blocked port). It prints the link only when no browser can be opened; set `MUVLOOM_NO_BROWSER=1` to never open one (SSH, containers, a remote machine). Running it again after a timeout resumes the same login without a new page. `--no-wait` (advanced) prints the link and returns; `--switch-service` signs in to `MUVLOOM_API_URL` even though this machine is signed in to another service |
| `muvloom auth logout` | Revoke this CLI connection and forget it |
| `muvloom capabilities` | Models, aspect ratios, image sizes, qualities, `output_formats` (`image`, plus `gif` / `svg` where the model outputs them directly, with their limits and prices), base-price estimates, limits for this account |
| `muvloom images validate --prompt T [flags]` | Optional request validation or a cost quote when the user asks; creates nothing |
| `muvloom images create --prompt T [flags] [--max-credits N] [--idempotency-key K] [--wait S] [--download DIR]` | Submit one image; `--output-format gif\|svg` (with `--frames`, `--frame-duration-ms`, `--frame-size` for GIF) on models that list it; downloads keep the right extension |
| `muvloom jobs get ID` / `jobs wait ID [--timeout S]` / `jobs cancel ID` | One job |
| `muvloom jobs list [--limit N] [--cursor ID] [--idempotency-key K]` | Recent jobs, newest first |
| `muvloom media upload FILE` / `media list` / `media get ID` / `media download ID [--output P]` | Reference images (`media_id`) |
| `muvloom artifacts get ID` / `artifacts download ID [--output P]` | Generated results (`artifact_id`) |
| `muvloom skill install --host claude-code\|codex [--scope user\|project]` / `skill status` | This Skill |

IDs: `job_id` is a generation task, `artifact_id` a generated image, `media_id` an uploaded reference image. They are not interchangeable.

Capability prices are live backend base-unit prices (multiplier 1), not a final
quote for every resolution or quality. When the user asks what a specific request
will cost, use `images validate` with those exact flags; its quote includes the
request's size/quality multiplier. Keep pricing internal unless the user asks.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Success | Read `data` |
| 2 | Invalid command or request | Fix the flags or ask the user for the missing input |
| 3 | Not signed in / login pending, denied or expired | Run the login flow |
| 4 | Rejected (membership, not found, conflict, model unavailable, file exists, service mismatch, credential store unwritable) or the waited job failed / was canceled | Explain to the user; see errors.md |
| 5 | Credits (insufficient, or above `--max-credits`) | Report insufficient credits or the exceeded user-supplied limit; stop |
| 6 | Temporary (network, rate limit, server busy) | Retry later with the same idempotency key |
| 7 | CLI too old | Upgrade with install.md |
| 1 | Unexpected | Report the message |
