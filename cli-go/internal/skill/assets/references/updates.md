# Updates

Run `muvloom update check` at Skill startup. It returns `status`, `current_version`,
`latest_version`, `checked_at`, `cached`, `should_prompt`, and the current
`install_directory`. Checks and failed attempts are cached until the next local
calendar day. A cached result never asks again that day. `unavailable` is
non-blocking; resume the user's task.

When `should_prompt: true`, briefly tell the user that a newer Muvloom version is
available and ask whether to update. Continue their requested task while awaiting
the reply. A refusal keeps the installed version; no upgrade runs without approval.

After approval:

1. Let any active local CLI command return before replacing its executable.
   Install the exact approved `latest_version` using [install.md](install.md).
   Set `MUVLOOM_VERSION` only for the installer invocation, and use the returned
   `install_directory` as `MUVLOOM_INSTALL_DIR` to replace the existing CLI.
2. Check `muvloom version`, then run `muvloom auth status`: it refreshes all
   registered Skill installs, as described in install.md. Existing login credentials
   are retained.
3. Resume the original task. Report an installation failure without falling back
   to another source or requesting the user's password or token.

An already-running generation continues on the server during an upgrade. Resume
that same job using its saved ID or idempotency key instead of submitting again.
