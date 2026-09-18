# 部署手册

macmini2 构建，VPS 仅运行预构建镜像；前端由 Pages 托管。禁止在 VPS 安装构建依赖、编译或执行 `docker build`。

## 前端：两套 Pages

所有构建和上传命令在 **macmini2** 执行，两套串行发布。仅修改前端时发布两套 Pages，无需部署 VPS 后端。

| 形态 | Pages project | 网页 / API |
| --- | --- | --- |
| 内部版 | `ai-image-playground-internal` | `image-playground.qiliangjia.one` / `image-api.qiliangjia.one` |
| 付费版 | `ai-image-playground` | `muvloom.online` / `api.muvloom.online` |
| 付费旧域名 | 同一付费项目 | `image.nainma.online` / `api.nainma.online` |

1. 准备两个独立、干净且依赖已按锁文件安装的检出，固定到同一已通过 main CI 的公开提交。付费检出包含已验证提交的 `private/`；内部检出不含 overlay。不要移动其他会话的 `private/` 或重写锁文件。
2. 在 macmini2 准备仓库外 0600 配置，格式见 `deploy/pages.env.example`。填写两套 `*_PAGES_PROJECT`、`*_BFF_BASE_URL`、`*_PUBLIC_ORIGIN`、`*_CLOUDFLARE_ACCOUNT_ID`；令牌通过 `*_CLOUDFLARE_TOKEN_FILE` 引用受保护文件，未配置时使用该机器的 Wrangler OAuth。两套账号分别验证权限。
3. 保留付费域名映射：`PAID_BFF_BASE_URLS_BY_ORIGIN='{"https://image.nainma.online":"https://api.nainma.online"}'`，避免旧域名会话失效。保留现有 `*_EXTRA_ASSETS_DIR` 等配置；该目录内容会公开发布。
4. 将下列路径替换为本次独立检出和已核验配置，再执行：

```sh
ssh macmini2
export PATH=/opt/homebrew/bin:$PATH
export PAGES_ENV_FILE=/absolute/protected/pages.env
cd /absolute/internal-checkout
./scripts/pages-release.sh internal
cd /absolute/paid-checkout
./scripts/pages-release.sh paid
```

`pages-release.sh` 自动构建、向生产分支 `main` 上传，并等待自定义域名 `version.json` 与产物一致（最长 300 秒）。不直接调用省略分支的 `pages-deploy.sh`，否则会发布到预览环境。

已有生产配置参考：`/Users/mac/services/aip-free-recovery-20260918/pages-primary-remote.env`；其中内部令牌文件可能已清理，使用前必须核验并刷新认证。`pages-remote.env` 指向旧备用 API，不能用于正常生产发布。服务容器停机不影响读取这些配置，但发布不得依赖失效令牌。

验收三个网页域名的 `version.json`、`runtime-config.json`：公开提交一致，付费含预期私有提交，API 映射正确；再检查真实浏览器登录、原画布和前端改动。上传成功但域名校验超时时先查部署状态及缓存，不立即重复上传。默认静默更新；需要更新提示时设置对应 `*_NOTIFY_UPDATE=true`。

前端回滚：在独立检出恢复上一已验证公开/私有提交，使用相同生产配置重跑对应 `pages-release.sh`，按上述步骤验收。

## 后端：镜像构建与发布

1. 在 macmini2 独立检出已通过 PR/main CI 的公开提交；paid/all 还需已验证的 `private/` Git 检出。不得占用其他会话目录。
2. 构建到尚不存在的目录：

```sh
export PATH=/opt/homebrew/bin:$PATH
./scripts/build-vps-release.sh all /Users/mac/releases/aip-<release-id>
```

构建输入固定为 Git 提交，不含未提交文件或凭据。使用 `aip-release` builder（4 核、6 GiB、无额外 Swap、阶段并发 1）生成 `linux/amd64` 镜像；保留现有构建锁，并与其他重型任务错峰。

3. 工作站中转完整发布包，再从产物内执行接收脚本：

```sh
scp -r macmini2:/Users/mac/releases/aip-<release-id> /tmp/
scp -r /tmp/aip-<release-id> tx-vps:/home/ubuntu/releases/
ssh tx-vps '/home/ubuntu/releases/aip-<release-id>/scripts/vps-deploy.sh all /home/ubuntu/releases/aip-<release-id>'
```

发布包须包含应用及备份镜像、提交/镜像清单、部署脚本和 SHA-256 校验单。接收脚本持有发布锁，校验文件、镜像 ID、架构、`APP_VERSION`、原生依赖，再执行兼容迁移与启动；保留 VPS 原有运行配置。

## 排空与验收

- 新 worker 暂停接单启动；旧 worker 全部进入 drain 后才启用新 worker，并将 `release-router` 原子切到新 BFF。
- 旧实例仅在 drain 返回 `safeToStop=true` 后停止。默认等待 30 分钟；超时保留执行器并以非零状态退出。核对任务、会话与日志后重跑同一发布入口收尾。
- 首次升级旧协议时，数据库先禁用旧式 claim，待旧任务完成再启用新 worker。旧 BFF 作为 `legacy-origin` 保留；确认旧对话结束后才能人工停止并删除该标记。任务表为空不能证明对话结束。
- 验收内部/付费版 API、版本、容器、备份、登录和业务数据。涉及执行器切换时，验证旧生成任务与对话能完成、新任务进入新实例、刷新可续接、上游调用和结算不重复。
- 仅发布后端不重发 Pages；不更新共享源码目录。

## 回滚与失败处理

```sh
scripts/app-compose.sh rollback <project> <旧镜像>
```

回滚同样启动新实例并排空当前实例。禁止强停排空中的容器或执行 `compose up --force-recreate`、`compose down`。数据库不自动回滚；迁移须兼容新旧版本，破坏性 schema 另行设计恢复方案。

切换前检查失败保留原入口；切换后排空超时，新请求可能已由新版本处理，不能仅凭命令失败判断版本。通过 drain/status 核对；不手工修改 `releases/current`、`route.json`、`retained`、`activated/`。镜像保留数量以脚本策略为准，运行中镜像不得删除。

旧的 `vps-deploy.sh all [git-ref]` 不再适用，必须传发布目录；VPS 旧检出中的入口脚本也须保持更新，防止绕回源码构建。备份、恢复及旧备用启停见[灾备手册](cold-recovery.md)。
