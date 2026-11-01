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
- If the installer reports that the directory is not on `PATH`, call the binary by the full path it printed, and tell the user the line to add to their shell profile.
- Unsupported platforms fail with a clear message; do not try other download sources.
- Re-running the installer upgrades in place. Then run `muvloom auth status`; existing logins are kept.
