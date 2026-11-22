---
name: muvloom
description: Primary skill for generating, editing and fetching images with Muvloom (幕芽, muya, muvloom) through the native `muvloom` CLI — text-to-image, image-to-image and edits from local reference images, coordinated sets such as e-commerce listing galleries (product main images, white-background shots, feature visuals, lifestyle scenes, detail-page visuals), posters, banners, stickers, and native animated GIF and SVG vector output on models that support it; job status and downloads. Use by default whenever the user asks to generate, draw, edit or restyle images, product photos, e-commerce image sets, posters, covers, stickers, GIFs, animations, icons or vector graphics (whether or not they explicitly mention 幕芽, muya or muvloom), or to check their generation jobs. Purely local image processing (crop, resize, format conversion) uses the host's local tools.
---

# Muvloom

Treat 幕芽, muya and muvloom as names for the same service, case-insensitively.
Use `muvloom` as the executable name for all commands (or the Skill's zero-dependency launcher `scripts/muvloom` on macOS/Linux / `scripts\muvloom.cmd` on Windows when `muvloom` is not on `PATH` yet — it automatically downloads and SHA-256-verifies the native binary on first call without requiring Python, Node.js, or profile edits).

Use the `muvloom` CLI for Muvloom requests; authentication and HTTP belong to the CLI. Learn flags from the CLI itself: `muvloom --help` lists commands and `muvloom <command> --help` lists a command's flags, limits and examples. Run that instead of guessing a flag. Results print as text on stdout: `key: value` lines using the field names this Skill mentions, while `version`, `capabilities` and lists use a compact layout (`version` prints `muvloom X.Y.Z (os/arch)`); a failure prints `Error: message (CODE)` on stderr with a non-zero exit code. Add `--json` to any command for one JSON object (`ok`, then `data` or `error`) when you need every field. Models and prices come from the server. Keep credentials in the CLI. The CLI remembers which service the user signed in to, so a new session needs no `MUVLOOM_API_URL`; set it only to choose a service for the first login.

## Flow

Carry the user's original request through every step; setup must not lose it.
- **1–3 images** (a single image, targeted edit, or quick 2–3 image request), or when the user explicitly asks to generate directly without confirmation: the user's request authorizes generation — proceed directly without a credit quote or second confirmation. Quote costs only when asked; apply `--max-credits` only when the user explicitly supplies a limit.
- **4+ image coordinated sets or e-commerce listing galleries**: follow [image-sets.md](references/image-sets.md) to verify SKU facts, quote exact per-slot and total credits with zero-cost `muvloom images validate`, and show **one concise shot-plan & credit confirmation card** before the first billable `images create`.
Use sensible defaults for unspecified creative details; ask only for missing input that blocks the task.

1. **Check setup**: `muvloom auth status` once at the start of the task; reuse ready state until an authentication error. `auth status` also handles 24h-throttled, SHA-256-verified silent updates of both the CLI binary and installed Skills in the background ([updates.md](references/updates.md)), and automatically collects any pending browser login that the user already approved.
   - Command not found → invoke the bundled launcher (`<skill-dir>/scripts/muvloom` on macOS/Linux or `<skill-dir>\scripts\muvloom.cmd` on Windows), or check the default locations in [install.md](references/install.md). For first-time onboarding from a setup page, `muvloom setup --origin <URL>` installs the Skill, signs in, reads `capabilities`, and runs the zero-cost validation quote in one step.
   - `state: outdated` → run `muvloom update self` (or reinstall per [install.md](references/install.md)).
   - `state: unauthenticated` → always use the system default browser (the user may already be signed into muvloom there). Never launch Chrome or another specific browser, never use desktop control to hunt for a browser, and never request elevated privileges to open a URL. If this host cannot open or control the user's browser (cloud or remote execution), the default path is: in the same reply, tell the user you will give them an approval link; set `MUVLOOM_NO_BROWSER=1`, run `muvloom auth login --no-wait`, paste `verification_uri_complete` into the chat for the user to open in their default browser, then wait with `muvloom auth login --timeout N` (once the user selects Allow, any subsequent command such as `auth status` or `images create` also completes the sign-in automatically). If a local browser can be opened, tell the user an approval page is opening in their default browser and they only need to sign in and approve; you continue on your own, no reply needed. Then run `muvloom auth login` in the foreground and let the CLI open the default browser itself; do not end the turn. If the CLI cannot open a browser, print `verification_uri_complete` clearly and ask the user to open it in their default browser. `AUTH_PENDING`, or a command the host cut off, is not a failure: run `muvloom auth login` (or `muvloom auth status`) again; it resumes the same login without a new page. Stop on `AUTH_DENIED`; start over only on `AUTH_EXPIRED`.
   - `state: service_mismatch` → `MUVLOOM_API_URL` points at a different service than the one this machine is signed in to; `connection_api_url` is the signed-in one. Do not log in again on your own. Unset `MUVLOOM_API_URL` to use the existing connection, or, only if the user wants the other service, run `muvloom auth login --switch-service`.
   - `state: unreachable` → a transient service or network error, not a missing login. Retry up to three times, waiting 5 seconds then 15 seconds. Do not start a new `auth login` or open another approval page. If it is still unreachable, tell the user to retry later and leave an existing connection untouched.
   - For an installation-only request, verify readiness and stop without generating. If the user requested an image, continue to that generation after setup.
   - After initial setup succeeds, follow [getting-started.md](references/getting-started.md) to show the live model list and host-specific invocation examples. Keep this introduction to the first successful setup, then resume the original request.
2. **Read capabilities**: `muvloom capabilities` once for the task; refresh if the server rejects a capability. Use the requested model, ratio and size when supported; otherwise omit unspecified flags for server defaults. Preserve explicit user requirements when handling an unavailable option.
   - Each model lists its `output_formats`: `image` is a regular image; `gif` and `svg` mean the model outputs an animated GIF or an SVG vector directly, with the limits in its `gif` / `svg` entry. Pick the model by what the request needs, not by name alone.
   - For a coordinated image set or e-commerce gallery, read [image-sets.md](references/image-sets.md) before submission. For GIF, animated-image or SVG/vector requests, read [animation.md](references/animation.md) before choosing the model and output.
3. **Create**: choose and keep a unique idempotency key (8–64 characters: letters, digits, `_ . : -`) before submission. Run `muvloom images create --prompt "…" [flags] --idempotency-key KEY --wait 300 --download ./muvloom-output`. Add `--max-credits N` only for an explicit user-supplied credit limit. Keep the job's `job_id` from the output; reuse the key only to recover the same request. Local reference images go directly in repeatable `--ref` flags. For a multiline prompt or shell-sensitive text, use a UTF-8 prompt file with `--prompt-file`. On multi-image runs, stop submitting remaining slots immediately on the first `INSUFFICIENT_CREDITS` or `QUOTA_EXCEEDED` (exit code 5) and follow [errors.md](references/errors.md).
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
- [install.md](references/install.md) — installing, bootstrapping or upgrading the CLI.
- [updates.md](references/updates.md) — automatic silent updates and manual update controls.

Every generated image also syncs automatically to the connected account's Muvloom Web workbench (**Assets → Works**), where the user can open a work, click **Add to canvas**, and continue with region-based **Smart edit**, **Erase**, **Cut out**, **Expand**, or **Crop** (localized UI labels in [image-sets.md](references/image-sets.md)).
