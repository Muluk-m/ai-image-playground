# 部署手册

前端由 Pages 托管，允许本机构建发布；后端镜像在 macmini2 构建，VPS 仅运行预构建镜像。禁止在 VPS 安装构建依赖、编译或执行 `docker build`。

## 前端：两套 Pages

构建和上传可在本机执行，资源紧张时改用 macmini2；两套串行发布。仅修改前端时发布两套 Pages，无需部署 VPS 后端。

| 形态 | Pages project | 网页 / API |
| --- | --- | --- |
| 内部版 | `ai-image-playground-internal` | `image-playground.qiliangjia.one` / `image-api.qiliangjia.one` |
| 付费版 | `ai-image-playground` | `muvloom.online` / `api.muvloom.online` |
| 付费旧域名 | 同一付费项目 | `image.nainma.online` / `api.nainma.online` |

1. 准备两个独立、干净且依赖已按锁文件安装的检出，固定到同一已通过 main CI 的公开提交。付费检出包含已验证提交的 `private/`；内部检出不含 overlay。不要移动其他会话的 `private/` 或重写锁文件。
2. 在执行发布的机器准备仓库外 0600 配置，格式见 `deploy/pages.env.example`。填写两套 `*_PAGES_PROJECT`、`*_BFF_BASE_URL`、`*_PUBLIC_ORIGIN`、`*_CLOUDFLARE_ACCOUNT_ID`；令牌通过 `*_CLOUDFLARE_TOKEN_FILE` 引用受保护文件，未配置时使用该机器的 Wrangler OAuth。两套账号分别验证权限。
3. 保留付费域名映射：`PAID_BFF_BASE_URLS_BY_ORIGIN='{"https://image.nainma.online":"https://api.nainma.online"}'`，避免旧域名会话失效。保留现有 `*_EXTRA_ASSETS_DIR` 等配置；该目录内容会公开发布。
4. 将下列路径替换为本次独立检出和已核验配置，再执行：

```sh

# 若选择远端发布，先 ssh macmini2；本机发布直接执行以下命令。
export PATH=/opt/homebrew/bin:$PATH
export PAGES_ENV_FILE=/absolute/protected/pages.env
cd /absolute/internal-checkout
./scripts/pages-release.sh internal
cd /absolute/paid-checkout
./scripts/pages-release.sh paid
```

`pages-release.sh` 自动构建、向生产分支 `main` 上传，并等待自定义域名 `version.json` 与产物一致（最长 300 秒）。不直接调用省略分支的 `pages-deploy.sh`，否则会发布到预览环境。

macmini2 现有生产配置参考：`/Users/mac/services/aip-free-recovery-20260918/pages-primary-remote.env`；其中内部令牌文件可能已清理，使用前必须核验并刷新认证。`pages-remote.env` 指向旧备用 API，不能用于正常生产发布。服务容器停机不影响读取这些配置，但发布不得依赖失效令牌。本机使用本机受保护配置与凭据路径，不直接引用 macmini2 的绝对路径。

验收三个网页域名的 `version.json`、`runtime-config.json`：公开提交一致，付费含预期私有提交，API 映射正确；再检查真实浏览器登录、原画布和前端改动。上传成功但域名校验超时时先查部署状态及缓存，不立即重复上传。默认静默更新；需要更新提示时设置对应 `*_NOTIFY_UPDATE=true`。

前端回滚：在独立检出恢复上一已验证公开/私有提交，使用相同生产配置重跑对应 `pages-release.sh`，按上述步骤验收。

## 后端：镜像构建与发布

镜像经私有 GHCR `ghcr.io/muluk-m/ai-image-playground`（owner 必须小写）传输，VPS 按 digest 拉取，只传变更层。发布目录只含脚本、Compose、`images.tsv` 与 `SHA256SUMS`，体积很小，可经工作站中转。

1. 构建机：GitHub Actions `ubuntu-latest`（`GITHUB_ACTIONS=true`）或 macmini2 手动兜底；其他 Linux 拒绝构建。独立检出已通过 PR/main CI 的公开提交；paid/all 还需已验证的 `private/` Git 检出。不得占用其他会话目录。
2. 构建到尚不存在的目录：

```sh
export PATH=/opt/homebrew/bin:$PATH   # 仅 macmini2
./scripts/build-vps-release.sh all /Users/mac/releases/aip-<release-id>
```

构建输入固定为 Git 提交，不含未提交文件或凭据。使用 `aip-release` builder（4 核、6 GiB、无额外 Swap、阶段并发 1）生成 `linux/amd64` 镜像；保留现有构建锁，并与其他重型任务错峰。每个镜像构建后立即推送，远端标签 `internal-<公开12位>`、`paid-<公开12位>-<私有12位>`、`backup-<公开12位>`，本地标签不变。首次推送上传全部层，之后只传变更层。

3. 工作站中转发布目录，再从产物内执行接收脚本：

```sh
scp -r macmini2:/Users/mac/releases/aip-<release-id> /tmp/
scp -r /tmp/aip-<release-id> tx-vps:/home/ubuntu/releases/
ssh tx-vps '/home/ubuntu/releases/aip-<release-id>/scripts/vps-deploy.sh all /home/ubuntu/releases/aip-<release-id>'
```

接收脚本持有发布锁，校验 `SHA256SUMS`（须覆盖目录内全部文件，多出未列文件即拒绝），按 digest `docker pull` 并打回本地标签，再校验镜像 ID、架构、`APP_VERSION`、原生依赖，最后执行兼容迁移与启动；保留 VPS 原有运行配置。任一镜像拉取或校验失败都不改动服务。

### `images.tsv`

每行一个镜像，制表符分隔：`形态 本地标签 镜像ID 公开提交 私有提交 仓库digest`。形态为 `internal`/`paid`/`backup`；私有提交无则为 `-`；第 6 列形如 `ghcr.io/muluk-m/ai-image-playground@sha256:<64位>`，archive 发布为 `-`。只有 5 列的旧发布包仍可接收。

### 凭据

| 文件（0600） | 机器 | 权限 | 用途 |
| --- | --- | --- | --- |
| `~/.config/ai-image-playground/ghcr-push-token` | macmini2 | `write:packages`（用户 `Muluk-m`） | 手动构建推送 |
| `~/.config/ai-image-playground/ghcr-pull-token` | tx-vps | `read:packages` | 接收拉取 |

脚本先用 Docker 已存凭据（`docker login ghcr.io`），失败才读令牌文件经 stdin 登录（`-u Muluk-m --password-stdin`），不回显令牌；`GHCR_PUSH_TOKEN_FILE`/`GHCR_PULL_TOKEN_FILE` 可改路径。GitHub Actions 由 workflow 先登录（`GITHUB_TOKEN`，`packages: write`），脚本不读令牌文件。

轮换：在 GitHub 新建同权限 classic token → 写入对应文件（`umask 077`，覆盖原文件）→ 该机 `docker logout ghcr.io && docker login ghcr.io -u Muluk-m --password-stdin < <文件>` 验证 → 吊销旧 token。

### archive 兜底

GHCR 不可用时构建加 `RELEASE_TRANSPORT=archive`：不登录、不推送，照旧生成 `images.tar.gz`（约 800 MB）并列入 `SHA256SUMS`，`images.tsv` 第 6 列为 `-`。接收端见到 `images.tar.gz` 即走 `docker load`；既无归档又无 digest 的发布包直接拒绝。

## 排空与验收

每套最多两代执行器：在线一代与发布中的一代（[ADR 0009](../adr/0009-preserve-executors-during-rollout.md) 2026-09-18 补充）。`rollout-runtime.sh` 顺序：

1. 预检：停止并删除 `releases/current` 以外的全部带标签执行器（不探测，死容器不阻塞发布），清理 `activated/` 残留与已废弃的 `retained`。
2. 兼容迁移；启动新 BFF、暂停接单的新 worker，均需健康。
3. `release-router` 不存在则创建；镜像与本次不同则同别名启动新路由、健康后停旧路由（旧路由在途请求有 30 秒收尾，更早镜像的旧路由会直接断开，客户端重连）。检查隧道指向路由。
4. 旧 worker 全部进入 drain 后启用新 worker，再原子切换 `route.json` 与 `current`。
5. 切换后旧一代最多排空 `DEPLOY_DRAIN_DEADLINE_SECONDS`（默认 300）。到期仍在执行的发 SIGTERM，宽限 `DEPLOY_STOP_GRACE_SECONDS`（默认 75）后删除。被打断的队列任务按租约回收并续轮询已提交的上游任务，不重提；被打断的对话轮由新一代补写终帧并续跑一次，原轮预扣退回、续跑轮计费一次。输出如实给出「N 个排空完成、M 个到期强停、K 个已停止」；强停不算失败，退出码仍为 0。
6. 更新 admin、host-collector、pg-backup。

- 旧 BFF 报告结算写入失败时只告警（`recorded a failed durable settlement`），不再阻止停止；到期后由恢复扫描补写。容器删除后日志随之删除，看到告警当场取日志。
- 验收内部/付费版 API、版本、容器（每套只剩一代 `-bff`/`-worker`）、备份、登录和业务数据。涉及执行器切换时，验证新任务进入新实例、刷新可续接、上游调用和结算不重复。
- 仅发布后端不重发 Pages；不更新共享源码目录。

### 一次性退役旧 BFF（`legacy-origin`）

首次升级旧协议时，数据库先禁用旧式 claim，待旧任务完成再启用新 worker；旧 Compose BFF（`<project>-bff-1`）记为 `legacy-origin`，第 0 代对话仍转发给它。它没有排空接口，按以下步骤单独退役一次，每套各执行一次：

1. 确认它近期没有对话活动：`docker logs --since 15m <project>-bff-1`；选低峰期。
2. 在下一次正常发布时带上退役开关（环境变量会传到每套的发布）；不等发布时，用发布目录内的脚本对当前镜像重跑一次：

```sh
ssh tx-vps 'DEPLOY_RETIRE_LEGACY=1 /home/ubuntu/releases/aip-<release-id>/scripts/vps-deploy.sh all /home/ubuntu/releases/aip-<release-id>'
# 或单套，镜像取自 `docker inspect --format '{{.Config.Image}}' <当前 -bff>`
DEPLOY_RETIRE_LEGACY=1 /home/ubuntu/releases/aip-<release-id>/scripts/app-compose.sh rollback <project> <当前镜像>
```

新一代不带 `LEGACY_EXECUTOR_ORIGIN` 启动，接管第 0 代对话；切换后上一代照常限时排空，随后旧 BFF/worker 以 SIGTERM 加宽限停止并删除，`legacy-origin` 删除。输出 `Legacy executor … retired` 即完成。切换前失败则旧 BFF 与标记原样保留。没有标记时提示 `nothing to retire` 并按普通发布执行。

3. 核对 `docker ps -a` 中不再有 `<project>-bff-1`/`<project>-worker-1`，第 0 代旧对话可打开并续聊。此后 `app-compose.sh up` 仍按 `releases/current` 走发布流程。

## 回滚与失败处理

```sh
scripts/app-compose.sh rollback <project> <旧镜像>
```

回滚与发布同一流程：启动旧镜像的新一代，限时排空当前一代后停止。禁止执行 `compose up --force-recreate`、`compose down`。数据库不自动回滚；迁移须兼容新旧版本，破坏性 schema 另行设计恢复方案。

切换前任一步失败（新实例不健康、新路由不健康、隧道不指向路由、新 worker 启用失败、旧协议任务超过期限），脚本删除本次创建的实例，恢复旧 worker 接单与 `activated/` 标记，重开旧式 claim，换回旧路由，以非零状态退出；线上仍是原一代。切换后不再失败回退，旧一代按期限停止。不手工修改 `releases/current`、`route.json`、`activated/`、`legacy-origin`；中断的发布由下一次发布的预检清理。镜像保留数量以脚本策略为准，运行中镜像不得删除。回滚只用 VPS 本地保留的镜像标签，不依赖 GHCR；本地镜像已被清理时，重跑对应发布目录的 `vps-deploy.sh` 会按 digest 重新拉取。GHCR 上的镜像本次不做清理。

旧的 `vps-deploy.sh all [git-ref]` 不再适用，必须传发布目录；VPS 旧检出中的入口脚本也须保持更新，防止绕回源码构建。备份、恢复及旧备用启停见[灾备手册](cold-recovery.md)。
