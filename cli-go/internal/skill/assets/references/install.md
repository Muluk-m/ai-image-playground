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

## Distribution verification and release approval

PR CI runs Go tests on macOS arm64/x64, Linux arm64/x64 and Windows x64. It builds all five native binaries with the same `cli-go/install/build-dist.py` used by the release workflow, then exercises the shell/PowerShell installers against those binaries and their real SHA-256 checksums. The distribution names are `muvloom_darwin_arm64`, `muvloom_darwin_amd64`, `muvloom_linux_arm64`, `muvloom_linux_amd64` and `muvloom_windows_amd64.exe`.

The smoke suite installs into isolated temporary user directories, checks missing releases, unsupported platforms, missing/mismatched checksums, redirect rejection and nonzero CLI exit propagation. It installs the bundled Skill for both Claude Code and Codex at user and project scope, then validates each installed directory with the real upstream [Agent Skills reference validator](https://github.com/agentskills/agentskills/tree/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref), pinned to source commit `69ef37e9424c0a7ea9dd2293b559e43ec8176379` (`skills-ref` 0.1.0), not a local substitute.

To run the same checks in an approved cloud environment (the output directory must be empty):

```sh
python -m pip install 'skills-ref @ git+https://github.com/agentskills/agentskills.git@69ef37e9424c0a7ea9dd2293b559e43ec8176379#subdirectory=skills-ref'
cd cli-go
go vet ./...
go test ./...
python install/build-dist.py --version 0.1.0 --output dist
python install/test-install.py --dist dist --version 0.1.0
```

`MUVLOOM_DISTRIBUTION_URL` is a CI-only fixture seam: only `http://127.0.0.1:PORT/PATH` is accepted, and redirects are forbidden. Leave it unset for official GitHub downloads. The smoke suite sets `MUVLOOM_NO_MODIFY_PATH=1` on Windows so it never changes the runner's persistent user PATH. Neither installer sends CLI credentials; the CLI's authenticated HTTP requests retain their no-redirect policy.

Passing PR checks produces Actions artifacts only. **Creating a `cli-vX.Y.Z` tag and publishing a real CLI release require separate explicit user approval.** CI smoke does not authorize publishing `cli-v0.1.0`, prove a public release already exists, or exercise authenticated production APIs. If no approved release exists, the public installer must fail rather than use an unverified substitute.
