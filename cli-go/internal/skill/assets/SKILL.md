---
name: muvloom
description: Use when the user asks to create, inspect, or manage Muvloom images, jobs, or media through the native CLI; do not use for unrelated tasks or direct API implementations.
---

# Muvloom

Use the native `muvloom` CLI as the only client for Muvloom operations. Do not recreate API calls, invent provider settings, or ask the user for a model, price, or duration that the service can choose dynamically.

## First use

1. Check the local installation and authentication without creating work:
   `muvloom version` and `muvloom auth status --json`.
2. If the binary is missing, follow [setup.md](references/setup.md) and install the native binary for the current platform. Node.js and npm are not prerequisites.
3. If authentication is missing, run `muvloom auth login --start`, show the verification details, and then run `muvloom auth login --resume` after the user completes browser authorization.
4. Query `muvloom capabilities` before offering an operation. Setup and capability checks must never create a task, charge, or sample image.

## Operations

Read the smallest relevant reference before acting:

- [cli.md](references/cli.md) for JSON output and command conventions.
- [capabilities.md](references/capabilities.md) before image creation.
- [jobs.md](references/jobs.md) for polling, listing, or cancelling jobs.
- [media.md](references/media.md) for uploads and downloads.
- [errors.md](references/errors.md) when a command fails.

Use `images create --prompt ...` only after the user has supplied a prompt and the requested capability is available. Preserve an idempotency key for retries. Report the CLI JSON response rather than claiming success before the command returns `ok: true`.

Never expose credentials or copy access tokens into prompts, files, or chat. The CLI owns credential storage and refresh.
