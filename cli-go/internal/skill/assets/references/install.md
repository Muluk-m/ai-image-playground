# Install or upgrade

The CLI is a single native binary (macOS arm64/x64, Linux x64/arm64, Windows x64). It does not need Node.js, npm or Python. The official installers download from the project's GitHub releases, verify the SHA-256 checksum, and install without administrator rights.

macOS / Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Muluk-m/ai-image-playground/main/cli-go/install/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/Muluk-m/ai-image-playground/main/cli-go/install/install.ps1 | iex
```

- Where it installs, unless `MUVLOOM_INSTALL_DIR` says otherwise: the directory of the copy that is already installed (so an upgrade replaces it and only one copy exists), else `/usr/local/bin` when that is on PATH and writable without sudo (macOS/Linux), else `~/.local/bin` (macOS/Linux) or `%LOCALAPPDATA%\Programs\muvloom` (Windows). Pin a release with `MUVLOOM_VERSION=0.1.0`. For a system-wide install that needs administrator rights, run it yourself with `sudo MUVLOOM_INSTALL_DIR=/usr/local/bin sh`.
- The installer prints the installed path. If that directory is not on PATH, the installer says so: on macOS/Linux run `export PATH="<that directory>:$PATH"` for this session; on Windows `irm … | iex` already updates the current session. A new session may not have the directory on PATH: before installing again, look for an existing copy (see "Finding an installed CLI" below).
- If the installer warns that another `muvloom` is earlier on PATH, that copy keeps running instead; call the new one by its full path, or tell the user to remove the old one.

## Finding an installed CLI

Agent shells often lack the directory the CLI was installed into, so `muvloom` can be missing from PATH while it is installed. Before installing, check these locations and use the first one that exists, by full path or after adding its directory to PATH for the session: `~/.local/bin/muvloom`, `/usr/local/bin/muvloom`, `/opt/homebrew/bin/muvloom` (macOS/Linux); `%LOCALAPPDATA%\Programs\muvloom\muvloom.exe` (Windows). Run `version` on it: install only when none exists or its version is older than the one this task needs.

- Unsupported platforms fail with a clear message; do not try other download sources.
- Re-running the installer upgrades the CLI in place; existing logins are kept. Then run `muvloom skill status`: refresh each reported installation with `muvloom skill install --host HOST --scope SCOPE`, using its existing `host` (`claude-code` or `codex`) and `scope` (`user` or `project`). Run project-scope refreshes from that project's directory so they update the same installation. Other hosts continue using CLI help. Finally run `muvloom auth status` and resume the original task.
