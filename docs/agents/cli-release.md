# 原生 CLI 发布与验证

维护者文档；用户安装与升级见 `cli-go/internal/skill/assets/references/install.md`。

## 版本单一来源

**CLI 版本只有一个来源：`cli-go/internal/version/VERSION`**（一行 `X.Y.Z`）。它在编译期被嵌入
（`cli-go/internal/version/version.go`），`muvloom version` 和内置 Skill 的元数据版本都取这一个值
（`internal/cli.Version`、`internal/skill.BundleVersion` 都写成 `version.Current`）。没有 `-ldflags -X`
覆盖：覆盖会让二进制自报的版本和编译进去的 Skill 元数据版本对不上，而这正是要消灭的那类漂移。
`go run` / `go test` 不带任何参数就是真实发布版本。

`cli-go/install/build-dist.py --version` 仍然必填，但现在只用来**校验**：它和 `VERSION` 不一致就直接
报错退出。发布流水线把 `cli-vX.Y.Z` 标签名传进来（`.github/workflows/cli-release.yml` →
`cli-checks.yml`），于是「标签 ≠ 源码版本」在构建第一步就失败，不会产出标错版本的 release。

剩下的几份拷贝（工作流默认标签、网页接入页固定值、三份接入指南、服务端最低版本）由
`scripts/check-cli-version.mjs` 校验，它挂在根 `pnpm lint` 里，并且 `.github/workflows/web.yml` 的
`lint` job 每个 PR 都跑（该 job 的检出带 `fetch-tags`，脚本要用 `git` 读 `cli-v*` 标签指向的提交）。
自测：`node --test scripts/__tests__/check-cli-version.test.mjs`。本地没有 `cli-v*` 标签时脚本只跳过
与标签相关的子检查并打印一条 notice，其余照常。

脚本强制的规则（V = `VERSION` 里的版本，P = 网页固定版本 `CLI_VERSION`，R = `CLI_RELEASE_REF`）：

| 规则 | 说明 |
| --- | --- |
| `internal/cli.Version`、`internal/skill.BundleVersion` 必须等于 `version.Current` | 任何一处写回 `"X.Y.Z"` 字面量就失败 |
| `cli-checks.yml` 的 `release-tag` 默认值 == `cli-vV` | PR 默认构建的就是当前源码版本 |
| 本文件里出现的 `--version X.Y.Z` 字面量 == V | 正文用 `$(cat VERSION)`，不留第二份拷贝；真写了字面量也会被校验 |
| 三份指南里的版本 == P，`raw.githubusercontent.com` 安装脚本提交 == R | 指南提到宿主自己的版本时，版本号前必须紧跟产品名（脚本的 `FOREIGN_VERSION`） |
| P == V，或 P == 上一个已发布版本且 `cli-vV` 标签还不存在 | 两提交发布流程中间那一个「源码超前一版」的状态是合法的，其他组合都是漏改 |
| 只要 `cli-vP` 标签存在，R 必须正好是该标签的提交 | `git for-each-ref` 取解引用后的提交，等同 `git rev-parse cli-vP^{commit}` |
| 服务端 `CLI_MIN_VERSION` ≤ P（因此也 ≤ V） | 见下方「服务端最低 CLI 版本」 |

### 发布 PR 要改的文件

发布流程仍是一个 PR 两个提交。**除下表之外没有别的地方需要改版本号**；改错或漏改由上面的检查拦住。

第一个提交（提版本，CI 过后在 PR head 上打 `cli-vX.Y.Z`，由 `cli-release.yml` 发布）：

| 文件 | 改什么 |
| --- | --- |
| `cli-go/internal/version/VERSION` | 新版本 `X.Y.Z`（唯一来源） |
| `.github/workflows/cli-checks.yml` | `release-tag` 默认值改成 `cli-vX.Y.Z` |

第二个提交（发布完成、用官方安装器实测过 `muvloom version` 之后，把网页和指南固定到已发布版本）：

| 文件 | 改什么 |
| --- | --- |
| `apps/web/src/features/cli/connectAgents.ts` | `CLI_VERSION` = 新版本；`CLI_RELEASE_REF` = `cli-vX.Y.Z` 标签指向的提交（`git rev-parse cli-vX.Y.Z^{commit}`） |
| `apps/web/public/cli/setup.md` | 安装命令里的 `MUVLOOM_VERSION`、URL 里的提交、正文「CLI X.Y.Z」 |
| `apps/web/public/cli/workbuddy.md` | 正文里的 CLI 版本 |
| `apps/web/workbuddy-skill/workbuddy.md` | 正文里的 CLI 版本 |

只在需要抬高服务端门槛时才动 `apps/bff/src/routes/cli.ts` 的 `CLI_MIN_VERSION`，并且只能在第二个
提交之后（或更晚的 PR 里）抬，规则见下一节。

### 服务端最低 CLI 版本

`GET /v1/me` 返回的 `min_cli_version` 来自 `apps/bff/src/routes/cli.ts` 的 `CLI_MIN_VERSION`，低于它的
CLI 会被要求升级。规则：

- **默认不动。** 只有当某个已发布版本的 CLI 在新服务端上确实不能正常工作（协议不兼容、已删除的接口、
  会产生错误结果的行为变更）时才抬高，并在 PR 的「成本与影响」之外写明哪些版本会被挡、为什么不能兼容。
- 抬高的上限是**网页当前固定的版本 P**：照着接入指南刚装完 CLI 的用户必须能用。想挡掉 P 本身，就得先
  发布并固定一个更新的版本，下一个 PR 再抬。`scripts/check-cli-version.mjs` 强制 `CLI_MIN_VERSION ≤ P`。
- 能靠服务端兼容处理的，就在服务端兼容，不要用抬最低版本来代替。

## Distribution verification and release approval

PR CI runs Go tests on macOS arm64/x64, Linux arm64/x64 and Windows x64. It builds all five native binaries with the same `cli-go/install/build-dist.py` used by the release workflow, then exercises the shell/PowerShell installers against those binaries and their real SHA-256 checksums. The distribution names are `muvloom_darwin_arm64`, `muvloom_darwin_amd64`, `muvloom_linux_arm64`, `muvloom_linux_amd64` and `muvloom_windows_amd64.exe`.

The smoke suite installs into isolated temporary user directories, checks missing releases, unsupported platforms, missing/mismatched checksums, redirect rejection and nonzero CLI exit propagation. It installs the bundled Skill for both Claude Code and Codex at user and project scope, then validates each installed directory with the real upstream [Agent Skills reference validator](https://github.com/agentskills/agentskills/tree/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref), pinned to source commit `69ef37e9424c0a7ea9dd2293b559e43ec8176379` (`skills-ref` 0.1.0), not a local substitute.

To run the same checks in an approved cloud environment (the output directory must be empty):

```sh
python -m pip install 'skills-ref @ git+https://github.com/agentskills/agentskills.git@69ef37e9424c0a7ea9dd2293b559e43ec8176379#subdirectory=skills-ref'
cd cli-go
go vet ./...
go test ./...
version=$(tr -d '[:space:]' < internal/version/VERSION)
python install/build-dist.py --version "$version" --output dist
python install/test-install.py --dist dist --version "$version"
```

`MUVLOOM_DISTRIBUTION_URL` is a CI-only fixture seam: only `http://127.0.0.1:PORT/PATH` is accepted, and redirects are forbidden. Leave it unset for official GitHub downloads. The smoke suite sets `MUVLOOM_NO_MODIFY_PATH=1` on Windows so it never changes the runner's persistent user PATH. Neither installer sends CLI credentials; the CLI's authenticated HTTP requests retain their no-redirect policy.

Passing PR checks produces Actions artifacts only. An agent may create the `cli-vX.Y.Z` tag once the release commit's PR checks pass (2026-11-08 decision; no separate approval); the tag must match `cli-go/internal/version/VERSION`, or `build-dist.py` refuses to build it. After the release workflow finishes, install the published version with the official installer into a temporary directory and check `muvloom version` before pinning the website to it (the second commit of the release PR — see 「发布 PR 要改的文件」). CI smoke does not prove a public release exists or exercise authenticated production APIs. If no published release exists, the public installer must fail rather than use an unverified substitute.
