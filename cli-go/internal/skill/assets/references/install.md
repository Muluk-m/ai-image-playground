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
- Re-running the installer upgrades the CLI in place; existing logins are kept. Since CLI 0.2.1 a `MUVLOOM_CONFIG_DIR` directory keeps its own login in files there and never touches the keychain login of the default directory; a login made there with an older CLI must be made again (`auth status` says so). Then run `muvloom auth status`: since CLI 0.2.2 it updates every registered Skill install that is of an older release to the bundled version — the Claude Code and Codex copies in the user's home, the project-scope copy of the nearest directory above the current one holding `.git`, `go.mod` or `package.json`, and each skills directory installed with `skill install --dir`. It leaves edited, incomplete or newer copies alone and names any copy it could not update, with the command that replaces it; run a suggested project-scope `skill install` from that project's directory. A host loads the updated Skill in its next session; the current session keeps the instructions it already read. A copy a host installed itself (WorkBuddy's) is listed by `skill status` with `managed: false`: it is reported but never replaced, and that host's own install guide updates it. Resume the original task.
