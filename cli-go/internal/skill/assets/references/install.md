# Install or upgrade

The CLI is a single native binary (macOS arm64/x64, Linux x64/arm64, Windows x64). It does not need Node.js, npm or Python. The official installers download from the project's GitHub releases, verify the SHA-256 checksum, and install into a user directory.

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Muluk-m/ai-image-playground/main/cli-go/install/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Muluk-m/ai-image-playground/main/cli-go/install/install.ps1 | iex
```

- Default install directory: `~/.local/bin` (macOS/Linux), `%LOCALAPPDATA%\Programs\muvloom` (Windows). Override with `MUVLOOM_INSTALL_DIR`; pin a release with `MUVLOOM_VERSION=0.1.0`.
- Make the install directory available to subsequent commands in this agent session: on macOS/Linux, run `export PATH="${MUVLOOM_INSTALL_DIR:-$HOME/.local/bin}:$PATH"`; in PowerShell, prepend `$env:MUVLOOM_INSTALL_DIR` or its default `$env:LOCALAPPDATA\Programs\muvloom` to `$env:Path`. Alternatively, use the installed binary's full path throughout the session.
- Unsupported platforms fail with a clear message; do not try other download sources.
- Re-running the installer upgrades in place; existing logins are kept. For Claude Code or Codex, also run `muvloom skill install --host claude-code` or `muvloom skill install --host codex` respectively to refresh the installed instructions from the new binary. Other hosts continue using CLI help. Then run `muvloom auth status` and resume the original task.
