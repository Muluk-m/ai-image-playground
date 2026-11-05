---
name: muvloom
description: Generate and fetch images with Muvloom (幕芽, muya, muvloom) through the native `muvloom` CLI — text-to-image, image-to-image from local reference files, job status and downloads. Use when the user asks to create images with 幕芽, muya or muvloom, or check their generation jobs; including editing local reference images with Muvloom. Purely local image processing uses the host's local tools.
---

# Muvloom

Treat 幕芽, muya and muvloom as names for the same service, case-insensitively.
Use `muvloom` as the executable name for all commands.

Use the `muvloom` CLI for Muvloom requests; authentication and HTTP belong to the CLI. Each command prints one JSON object on stdout (`ok`, then `data` or `error`); progress goes to stderr. Models and prices come from the server. Keep credentials in the CLI.

## Flow

Carry the user's original request through every step; setup must not lose it.
The user's request to generate authorizes that generation. Proceed directly without
a credit quote or a second confirmation. Quote costs only when the user asks;
apply a credit limit only when the user explicitly supplies one. Use sensible defaults
for unspecified creative details; ask only for missing input that blocks the task.

At each Skill startup, run `muvloom update check`. The CLI checks official stable
releases once per local calendar day. Offer an update only when `should_prompt`
is true; continue the original task while awaiting the user's choice. Update only
after authorization, following [updates.md](references/updates.md). An unavailable
check or a declined update does not block generation.

1. **Check setup**: `muvloom auth status` once at the start of the task; reuse ready state until an authentication error.
   - Command not found → install it with [install.md](references/install.md), then run `auth status` again.
   - `state: outdated` → reinstall the latest release ([install.md](references/install.md)).
   - `state: unauthenticated` → run `muvloom auth login --no-wait`, then open the returned `verification_uri_complete` in the user's browser yourself with the host's browser-opening tool (or a local desktop OS URL opener: macOS `open`, PowerShell `Start-Process`, Linux `xdg-open`). Over SSH or in a remote environment, use a browser tool on the user's computer. Once the page is open, ask the user to sign in and approve, then run `muvloom auth login` to wait for approval. Only if no suitable tool is available or opening fails, explain the limitation and provide `verification_uri_complete` and `user_code` for manual opening. No port forwarding is needed.
   - `state: unreachable` → retry once after a short delay; if still unreachable, report the error.
   - For an installation-only request, verify readiness and stop without generating. If the user requested an image, continue to that generation after setup.
2. **Read capabilities**: `muvloom capabilities` once for the task; refresh if the server rejects a capability. Use the requested model, ratio and size when supported; otherwise omit unspecified flags for server defaults. Preserve explicit user requirements when handling an unavailable option.
3. **Create**: choose and keep a unique idempotency key (8–64 characters: letters, digits, `_ . : -`) before submission. Run `muvloom images create --prompt "…" [flags] --idempotency-key KEY --wait 300 --download ./muvloom-output`. Add `--max-credits N` only for an explicit user-supplied credit limit. Keep `data.job.job_id` from the output; reuse the key only to recover the same request. Local reference images go directly in repeatable `--ref` flags. For a multiline prompt or shell-sensitive text, use a UTF-8 prompt file with `--prompt-file`.
4. **Finish and deliver**: a `wait_timed_out: true` response means the job is still running. Continue `muvloom jobs wait <job_id> --timeout 300` until it finishes, unless the user requested background submission. Once succeeded, download any remaining artifacts ([jobs.md](references/jobs.md)), show the images with the host's preview tools, and give the saved paths. A failed download only needs another download. Handle failed jobs with [errors.md](references/errors.md); explain a concrete blocker if completion is impossible.

Flags shared by `validate` and `create`: `--model`, `--aspect-ratio`, `--image-size`, `--quality`, `--ref <file-or-media_id>` (repeatable; local files upload automatically), `--prompt-file`.

## References

- [cli.md](references/cli.md) — every command and exit code.
- [jobs.md](references/jobs.md) — waiting, recovering a lost submission, cancelling.
- [errors.md](references/errors.md) — what to do for each error code (credits, membership, conflicts).
- [install.md](references/install.md) — installing or upgrading the CLI.
- [updates.md](references/updates.md) — daily update checks and authorized upgrades.

Generated images are artifacts in the user's Muvloom history; they are not saved to the asset library unless the user does that on the website.
