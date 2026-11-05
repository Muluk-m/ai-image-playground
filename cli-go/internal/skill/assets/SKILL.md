---
name: muvloom
description: Generate and fetch images with Muvloom through the native `muvloom` CLI — text-to-image, image-to-image from local reference files, job status and downloads. Use when the user asks to create images with Muvloom or check Muvloom jobs; not for editing local images or calling the API directly.
---

# Muvloom

The `muvloom` CLI is the only way to talk to Muvloom. Every command prints one JSON object on stdout (`ok`, then `data` or `error`); progress goes to stderr. Never call the HTTP API yourself, never read credential files, never guess models or prices — the server is authoritative.

## Flow

Carry the user's original request through every step; setup must not lose it.
The user's request to generate authorizes that generation. Proceed directly without
a credit quote or a second confirmation. Quote costs only when the user asks;
apply a credit limit only when the user explicitly supplies one.

1. **Check setup**: `muvloom auth status`.
   - Command not found → install it with [install.md](references/install.md), then run `auth status` again.
   - `state: outdated` → reinstall the latest release ([install.md](references/install.md)).
   - `state: unauthenticated` → run `muvloom auth login --no-wait`, then open the returned `verification_uri_complete` in the user's browser yourself with the host's browser-opening tool (or a local desktop OS URL opener: macOS `open`, PowerShell `Start-Process`, Linux `xdg-open`). Over SSH or in a remote environment, use a browser tool on the user's computer. Once the page is open, ask the user to sign in and approve, then run `muvloom auth login` to wait for approval. Only if no suitable tool is available or opening fails, explain the limitation and provide `verification_uri_complete` and `user_code` for manual opening. No port forwarding is needed.
   - `state: unreachable` → report `error`, stop.
   - Setup never generates an image or spends credits.
2. **Read capabilities**: `muvloom capabilities`. Pick the model, aspect ratio and image size the user asked for from this list; otherwise leave them out and the server defaults apply. 4K only appears when the account may use it.
3. **Create**: `muvloom images create --prompt "…" [flags] --wait 300 --download ./muvloom-output`. Add `--max-credits N` only for an explicit user-supplied credit limit. Keep `data.idempotency_key` from the output.
4. **Report**: on `job.status: succeeded`, give the saved file paths from `downloads`. On `JOB_FAILED`, report `error.details.job.error.message`. If `wait_timed_out` is true the job is still running on the server — say so and check later with `muvloom jobs wait <job_id>`.

Flags shared by `validate` and `create`: `--model`, `--aspect-ratio`, `--image-size`, `--quality`, `--ref <file-or-media_id>` (repeatable; local files upload automatically), `--prompt-file`.

## References

- [cli.md](references/cli.md) — every command and exit code.
- [jobs.md](references/jobs.md) — waiting, recovering a lost submission, cancelling.
- [errors.md](references/errors.md) — what to do for each error code (credits, membership, conflicts).
- [install.md](references/install.md) — installing or upgrading the CLI.

Generated images are artifacts in the user's Muvloom history; they are not saved to the asset library unless the user does that on the website.
