---
name: muvloom
description: Generate and fetch images with Muvloom through the native `muvloom` CLI — text-to-image, image-to-image from local reference files, quotes before spending credits, job status and downloads. Use when the user asks to create images with Muvloom or check Muvloom jobs; not for editing local images or calling the API directly.
---

# Muvloom

The `muvloom` CLI is the only way to talk to Muvloom. Every command prints one JSON object on stdout (`ok`, then `data` or `error`); progress goes to stderr. Never call the HTTP API yourself, never read credential files, never guess models or prices — the server is authoritative.

## Flow

Carry the user's original request through every step; setup must not lose it.

1. **Check setup**: `muvloom auth status`.
   - Command not found → install it with [install.md](references/install.md), then run `auth status` again.
   - `state: outdated` → reinstall the latest release ([install.md](references/install.md)).
   - `state: unauthenticated` → `muvloom auth login --no-wait`, show the user `verification_uri_complete` and `user_code`, ask them to approve in the browser, then run `muvloom auth login` (it waits for approval). Works over SSH; no port forwarding.
   - `state: unreachable` → report `error`, stop.
   - Setup never generates an image or spends credits.
2. **Read capabilities**: `muvloom capabilities`. Pick the model, aspect ratio and image size the user asked for from this list; otherwise leave them out and the server defaults apply. 4K only appears when the account may use it.
3. **Quote**: `muvloom images validate --prompt "…" [flags]`. Tell the user `quote.estimated_credits` and any `adjustments` (the server snapped a value to the nearest supported one). Ask before spending unless the user already approved a budget.
4. **Create**: `muvloom images create --prompt "…" [flags] --max-credits N --wait 300 --download ./muvloom-output`. Use the approved amount as `--max-credits`. Keep `data.idempotency_key` from the output.
5. **Report**: on `job.status: succeeded`, give the saved file paths from `downloads`. If `wait_timed_out` is true the job is still running on the server — say so and check later with `muvloom jobs wait <job_id>`.

Flags shared by `validate` and `create`: `--model`, `--aspect-ratio`, `--image-size`, `--quality`, `--ref <file-or-media_id>` (repeatable; local files upload automatically), `--prompt-file`.

## References

- [cli.md](references/cli.md) — every command and exit code.
- [jobs.md](references/jobs.md) — waiting, recovering a lost submission, cancelling.
- [errors.md](references/errors.md) — what to do for each error code (credits, membership, conflicts).
- [install.md](references/install.md) — installing or upgrading the CLI.

Generated images are artifacts in the user's Muvloom history; they are not saved to the asset library unless the user does that on the website.
