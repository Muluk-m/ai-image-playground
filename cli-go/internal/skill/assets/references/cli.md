# Commands

`muvloom --help` lists every command; `muvloom <command> --help` lists its flags,
defaults, limits and examples. Read those instead of guessing a flag: they always
match the installed CLI.

## Output

- Text (default): the result as `key: value` lines on stdout, with the field names
  below; nested values are indented, lists of records are tables. A failure prints
  `Error: message (CODE)` on stderr, then any details and a suggested next step.
  Progress lines also go to stderr.
- `--json` (anywhere before a `--`): exactly one JSON line on stdout,
  `{"schema_version":1,"ok":true,"data":…}` or
  `{"schema_version":1,"ok":false,"error":{"code","message","details"}}`. Use it
  when you need every field, for example the full `capabilities` limits.

The exit code is the same in both modes.

| Command | What to read from it |
| --- | --- |
| `auth status` | `state`: ready / unauthenticated / outdated / unreachable / service_mismatch; `api_url` and `api_url_source`; `credential_store` and `credential_store_issue`; `leftover_temp_files`; account, credits, membership, installed Skill |
| `auth login` | Opens the approval page itself and waits; prints the link only when no browser can be opened (`MUVLOOM_NO_BROWSER=1` never opens one). Run it again after a timeout: it resumes the same sign-in |
| `capabilities` | Each model's `output_formats`, ratios, sizes, qualities, reference-image limit, base price, and its `gif` / `svg` limits; account `limits` |
| `images validate` / `images create` | A quote, or the submitted `job` with its `job_id`, `idempotency_key`, `wait_timed_out` and `downloads` |
| `jobs get` / `wait` / `list` / `cancel` | Job `status`, `terminal`, `artifacts`, `actual_credits`; a list shows each job's artifact ids in its `artifacts` column, plus `next_cursor` |
| `media …` / `artifacts …` | Uploaded references (`media_id`) and generated results (`artifact_id`); downloads report the saved `path` |
| `update check`, `skill status`, `version` | Release check (`should_prompt`), installed Skills, CLI version. Each installed Skill reports `path`, `version`, `intact`, `current`, `managed` and, outside the fixed host locations, the `skills_dir` it was found in. `auth status` also updates every older, unedited copy the CLI installed — the fixed Claude Code and Codex locations and each directory installed with `--dir` — effective in the host's next session |
| `skill install` | Where the Skill went: `host`, `scope`, `path`. `--host claude-code\|codex` installs into that host's fixed location; `--dir DIRECTORY` installs into any host's skills directory, so the Skill lands in `<dir>/muvloom` (for example `--dir ~/.workbuddy/skills`) and that directory is remembered for later refreshes. A copy a host installed itself has `managed: false`: it is reported, never replaced |
| `skill print` | The bundled Skill on stdout, byte for byte, for a host that cannot install Skills: the body by default, one reference with `--file references/cli.md`, the printable file names with `--list` |

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
| 5 | Credits (insufficient, above `--max-credits`) or the daily quota is used up (`QUOTA_EXCEEDED`, with `reset_at`) | Report insufficient credits, the exceeded user-supplied limit, or when the quota resets; stop |
| 6 | Temporary (network, rate limit, server busy) | Retry later with the same idempotency key |
| 7 | CLI too old | Upgrade with install.md |
| 1 | Unexpected | Report the message |
