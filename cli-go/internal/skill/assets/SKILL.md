---
name: muvloom
description: Generate and fetch images with Muvloom (幕芽, muya, muvloom) through the native `muvloom` CLI — text-to-image, image-to-image and edits from local reference images, coordinated sets such as e-commerce galleries, and native animated GIF and SVG vector output on models that support it; job status and downloads. Use when the user asks to create images, stickers, GIFs, animations, icons or vector graphics with 幕芽, muya or muvloom, or to check their generation jobs. Purely local image processing uses the host's local tools.
---

# Muvloom

Treat 幕芽, muya and muvloom as names for the same service, case-insensitively.
Use `muvloom` as the executable name for all commands.

Use the `muvloom` CLI for Muvloom requests; authentication and HTTP belong to the CLI. Learn flags from the CLI itself: `muvloom --help` lists commands and `muvloom <command> --help` lists a command's flags, limits and examples. Run that instead of guessing a flag. Results print as text on stdout: `key: value` lines using the field names this Skill mentions, while `version`, `capabilities` and lists use a compact layout (`version` prints `muvloom X.Y.Z (os/arch)`); a failure prints `Error: message (CODE)` on stderr with a non-zero exit code. Add `--json` to any command for one JSON object (`ok`, then `data` or `error`) when you need every field. Models and prices come from the server. Keep credentials in the CLI. The CLI remembers which service the user signed in to, so a new session needs no `MUVLOOM_API_URL`; set it only to choose a service for the first login.

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
   - Command not found → the CLI may be installed but missing from this shell's PATH: look for it in the default locations ([install.md](references/install.md), "Finding an installed CLI") first, and install only if none exists. Then run `auth status` again.
   - `state: outdated` → reinstall the latest release ([install.md](references/install.md)).
   - `state: unauthenticated` → in the same reply, tell the user an approval page is opening and they only need to sign in and approve; you continue on your own, no reply needed. Then run `muvloom auth login` in the foreground with the host's longest command timeout, and do not end the turn: it opens the page in the user's browser itself and returns `state: ready` once they approve. `AUTH_PENDING`, or a command the host cut off, is not a failure: run `muvloom auth login` again; it resumes the same login without a new page. Stop on `AUTH_DENIED`; start over only on `AUTH_EXPIRED`. Over SSH or in a remote environment, set `MUVLOOM_NO_BROWSER=1`, run `muvloom auth login --no-wait`, open the returned `verification_uri_complete` with a browser tool on the user's computer, then run `muvloom auth login` to wait. If the host cuts the wait off twice in a row, ask the user to reply once they have approved, then run `muvloom auth login --timeout 15`.
   - `state: service_mismatch` → `MUVLOOM_API_URL` points at a different service than the one this machine is signed in to; `connection_api_url` is the signed-in one. Do not log in again on your own. Unset `MUVLOOM_API_URL` to use the existing connection, or, only if the user wants the other service, run `muvloom auth login --switch-service`.
   - `state: unreachable` → retry once after a short delay; if still unreachable, report the error.
   - For an installation-only request, verify readiness and stop without generating. If the user requested an image, continue to that generation after setup.
   - After initial setup succeeds, follow [getting-started.md](references/getting-started.md) to show the live model list and host-specific invocation examples. Keep this introduction to the first successful setup, then resume the original request.
2. **Read capabilities**: `muvloom capabilities` once for the task; refresh if the server rejects a capability. Use the requested model, ratio and size when supported; otherwise omit unspecified flags for server defaults. Preserve explicit user requirements when handling an unavailable option.
   - Each model lists its `output_formats`: `image` is a regular image; `gif` and `svg` mean the model outputs an animated GIF or an SVG vector directly, with the limits in its `gif` / `svg` entry. Pick the model by what the request needs, not by name alone.
   - For a coordinated image set or e-commerce gallery, read [image-sets.md](references/image-sets.md) before submission. For GIF, animated-image or SVG/vector requests, read [animation.md](references/animation.md) before choosing the model and output.
3. **Create**: choose and keep a unique idempotency key (8–64 characters: letters, digits, `_ . : -`) before submission. Run `muvloom images create --prompt "…" [flags] --idempotency-key KEY --wait 300 --download ./muvloom-output`. Add `--max-credits N` only for an explicit user-supplied credit limit. Keep the job's `job_id` from the output; reuse the key only to recover the same request. Local reference images go directly in repeatable `--ref` flags. For a multiline prompt or shell-sensitive text, use a UTF-8 prompt file with `--prompt-file`.
4. **Finish and deliver**: a `wait_timed_out: true` response means the job is still running. Continue `muvloom jobs wait <job_id> --timeout 300` until it finishes, unless the user requested background submission. Once succeeded, download any remaining artifacts ([jobs.md](references/jobs.md)), show the images with the host's preview tools, and give the saved paths. A failed download only needs another download. Handle failed jobs with [errors.md](references/errors.md); explain a concrete blocker if completion is impossible.

`muvloom images create --help` lists every generation flag (model, ratio, size, quality, reference images, prompt file, GIF/SVG output and frames); `images validate` takes the same flags.

If the host interrupts login for a permission approval or replays the command, run
`muvloom auth status` before starting another login. A `ready` state means the
connection succeeded. Do not describe an invalid or already-used code as expired,
or repeatedly open new authorization pages after the user has approved. Never
disable the host's file or credential protection.

## References

- [cli.md](references/cli.md) — output modes, IDs and exit codes.
- [jobs.md](references/jobs.md) — waiting, recovering a lost submission, cancelling.
- [errors.md](references/errors.md) — what to do for each error code (credits, membership, conflicts).
- [install.md](references/install.md) — installing or upgrading the CLI.
- [updates.md](references/updates.md) — daily update checks and authorized upgrades.

A host that cannot install Skills reads this body from `muvloom skill print`. With no
files on disk, read a reference this Skill points at with `muvloom skill print --file
references/cli.md`; `muvloom skill print --list` names them all.

Generated images are artifacts in the user's Muvloom history; they are not saved to the asset library unless the user does that on the website.
