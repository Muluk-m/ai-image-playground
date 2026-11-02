# Commands

All commands print exactly one JSON line on stdout: `{"schema_version":1,"ok":true,"data":…}` or `{"schema_version":1,"ok":false,"error":{"code","message","details"}}`.

| Command | Purpose |
| --- | --- |
| `muvloom version` | CLI version and platform |
| `muvloom auth status` | `state`: ready / unauthenticated / outdated / unreachable; account, credits, membership, installed Skill |
| `muvloom auth login [--no-wait] [--timeout S]` | Browser device login; `--no-wait` prints the link and returns |
| `muvloom auth logout` | Revoke this CLI connection and forget it |
| `muvloom capabilities` | Models, aspect ratios, image sizes, qualities, price per image, limits for this account |
| `muvloom images validate --prompt T [flags]` | Normalized request, `request_hash` and quote; creates nothing |
| `muvloom images create --prompt T [flags] [--max-credits N] [--idempotency-key K] [--wait S] [--download DIR]` | Submit one image |
| `muvloom jobs get ID` / `jobs wait ID [--timeout S]` / `jobs cancel ID` | One job |
| `muvloom jobs list [--limit N] [--cursor ID] [--idempotency-key K]` | Recent jobs, newest first |
| `muvloom media upload FILE` / `media list` / `media get ID` / `media download ID [--output P]` | Reference images (`media_id`) |
| `muvloom artifacts get ID` / `artifacts download ID [--output P]` | Generated results (`artifact_id`) |
| `muvloom skill install --host claude-code\|codex [--scope user\|project]` / `skill status` | This Skill |

IDs: `job_id` is a generation task, `artifact_id` a generated image, `media_id` an uploaded reference image. They are not interchangeable.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | Success | Read `data` |
| 2 | Invalid command or request | Fix the flags or ask the user for the missing input |
| 3 | Not signed in / login pending, denied or expired | Run the login flow |
| 4 | Rejected (membership, not found, conflict, model unavailable, file exists) or the waited job failed / was canceled | Explain to the user; see errors.md |
| 5 | Credits (insufficient, or above `--max-credits`) | Tell the user the required amount; do not raise the limit on your own |
| 6 | Temporary (network, rate limit, server busy) | Retry later with the same idempotency key |
| 7 | CLI too old | Upgrade with install.md |
| 1 | Unexpected | Report the message |
