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
- Re-running the installer upgrades the CLI in place; existing logins are kept. Then run `muvloom skill status`: refresh each reported installation with `muvloom skill install --host HOST --scope SCOPE`, using its existing `host` (`claude-code` or `codex`) and `scope` (`user` or `project`). Run project-scope refreshes from that project's directory so they update the same installation. Other hosts continue using CLI help. Finally run `muvloom auth status` and resume the original task.
