# CLI conventions

`muvloom` is a native executable and does not require Node.js, npm, or npx. Every command emits one JSON object on stdout. Success has `ok: true`; failures have `ok: false` and an `error` object with a stable `code`.

Use `--json` where a command offers it. Keep stdout machine-readable and send no tokens, credentials, or secrets to the shell history. Exit codes are stable: `0` success, `1` internal/network failure, `2` invalid request, `3` authentication required, `4` forbidden, `5` not found, `6` conflict, and `7` rate limited.

The API endpoint can be configured with `MUVLOOM_API_URL`. Credential storage is owned by the CLI; use `muvloom auth status --json`, `auth login`, and `auth logout` rather than inspecting credential files.
