# Updates

Both the `muvloom` CLI binary and installed Skills (`claude-code`, `codex`, `workbuddy`, `cursor`, `windsurf`, `cline`, `openclaw` copies and every directory installed with `skill install --dir`, each with `.muvloom-skill.json`) automatically check Muvloom's official `/cli/skill-manifest.json` at most once every 24 hours during `muvloom auth status`:

- **SHA-256 verified**: every binary and Skill archive is verified against exact byte count and SHA-256 before atomic replacement.
- **Non-blocking**: bounded timeout budget; offline or slow networks never fail or stall generation commands.
- **Safe for local edits**: Skill copies edited by the user (`intact: false`) are never overwritten automatically.
- **Credentials preserved**: logins are stored in `0600` files inside the `0700` muvloom config directory by default, so binary upgrades never trigger OS keychain password prompts.

## Manual update controls

- `muvloom update self` — check and self-update the `muvloom` CLI binary immediately.
- `muvloom update self --check` — check for a newer CLI binary without modifying disk.
- `muvloom update self --auto off` / `--auto on` — disable or re-enable automatic CLI self-updates.
- `muvloom update skill` — check and apply newer Skills immediately.
- `muvloom update skill --check` — check for newer Skills without modifying local files.
- `muvloom update skill --auto off` / `--auto on` — disable or re-enable automatic Skill hot-updates.
- `muvloom update check` — inspect the daily cached release status (`status`, `current_version`, `latest_version`, `install_directory`, `cli_auto_update`, `skill_auto_update`).

If `muvloom update self` cannot write to a root-owned directory (such as `/usr/local/bin`), follow [install.md](install.md) to upgrade with appropriate permissions or install into `~/.local/bin`.

An already-running generation continues on the server during an upgrade. Resume
that same job using its saved ID or idempotency key instead of submitting again.
