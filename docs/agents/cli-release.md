# 原生 CLI 发布与验证

维护者文档；用户安装与升级见 `cli-go/internal/skill/assets/references/install.md`。

## Distribution verification and release approval

PR CI runs Go tests on macOS arm64/x64, Linux arm64/x64 and Windows x64. It builds all five native binaries with the same `cli-go/install/build-dist.py` used by the release workflow, then exercises the shell/PowerShell installers against those binaries and their real SHA-256 checksums. The distribution names are `muvloom_darwin_arm64`, `muvloom_darwin_amd64`, `muvloom_linux_arm64`, `muvloom_linux_amd64` and `muvloom_windows_amd64.exe`.

The smoke suite installs into isolated temporary user directories, checks missing releases, unsupported platforms, missing/mismatched checksums, redirect rejection and nonzero CLI exit propagation. It installs the bundled Skill for both Claude Code and Codex at user and project scope, then validates each installed directory with the real upstream [Agent Skills reference validator](https://github.com/agentskills/agentskills/tree/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref), pinned to source commit `69ef37e9424c0a7ea9dd2293b559e43ec8176379` (`skills-ref` 0.1.0), not a local substitute.

To run the same checks in an approved cloud environment (the output directory must be empty):

```sh
python -m pip install 'skills-ref @ git+https://github.com/agentskills/agentskills.git@69ef37e9424c0a7ea9dd2293b559e43ec8176379#subdirectory=skills-ref'
cd cli-go
go vet ./...
go test ./...
python install/build-dist.py --version 0.2.7 --output dist
python install/test-install.py --dist dist --version 0.2.7
```

`MUVLOOM_DISTRIBUTION_URL` is a CI-only fixture seam: only `http://127.0.0.1:PORT/PATH` is accepted, and redirects are forbidden. Leave it unset for official GitHub downloads. The smoke suite sets `MUVLOOM_NO_MODIFY_PATH=1` on Windows so it never changes the runner's persistent user PATH. Neither installer sends CLI credentials; the CLI's authenticated HTTP requests retain their no-redirect policy.

Passing PR checks produces Actions artifacts only. Once checks and reviews are green, an agent may create the `cli-vX.Y.Z` release tag directly (see `docs/agents/release.md`). After the release workflow finishes, verify the published release by installing it into a temporary directory with the official installer and checking `muvloom version`. The website `/connect` page and setup guides always install the latest stable GitHub release without pinning a version; no separate website version bump is needed on routine CLI releases unless `install.sh` / `install.ps1` themselves change. CI smoke does not prove a public release exists or exercise authenticated production APIs. If no published release exists, the public installer must fail rather than use an unverified substitute.

## 版本号与发版清单

CLI 版本只有一个来源：`cli-go/internal/skill/install.go` 的 `BundleVersion`。`cli.Version` 默认取它，发布构建再用标签版本经 `-ldflags` 覆盖，两者必须相同。`scripts/check-cli-version.mjs`（在 `pnpm lint` 里）和 CLI 检查里的「Require the release tag to match BundleVersion」负责把关，任何一处不一致都会让 CI 失败。

发一个新 CLI 版本 `X.Y.Z`：

1. 开一个 PR，改这几处：
   - `BundleVersion` 改成 `X.Y.Z`；
   - `SkillVersion` 改成 `X.Y.Z`，之后只改 Skill 内容、不发 CLI 时再升成 `X.Y.Z.N`；
   - `.github/workflows/cli-checks.yml` 的 `release-tag` 默认值改成 `cli-vX.Y.Z`；
   - 本文示例命令里的 `--version`。
2. PR 检查和评审齐了就合并，在合并提交上打 `cli-vX.Y.Z` 标签。Release workflow 构建并发布到 GitHub。
3. 发一次生产前端（Deploy production）：网站同源 CDN 上的二进制和 `/cli/skill-manifest.json` 由前端构建按 `BundleVersion` 生成，已安装的 CLI 靠它们静默自升级。
4. 用官方安装脚本装到临时目录，确认 `muvloom version` 是 `X.Y.Z`。

服务端最低 CLI 版本是 `apps/bff/src/routes/cli.ts` 的 `CLI_MIN_VERSION`：低于它的 CLI 在 `auth status` 里被要求升级。只有服务端不再兼容旧 CLI（删掉或改坏了旧版本依赖的接口或字段）时才提高它，而且要在包含对应 CLI 版本的发版完成之后、单独开 PR 提高。平常发版不动它。
