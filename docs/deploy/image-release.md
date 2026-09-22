# 部署手册

前端由 Pages 托管，后端镜像经私有 GHCR 送到 VPS，VPS 仅运行预构建镜像。禁止在 VPS 安装构建依赖、编译或执行 `docker build`。

## 默认：合并 main 即部署

负责人决定（2026-09-18）：会话只负责合并到 `main`，不再手动发布；部署由 [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) 完成。下文手动步骤仅作应急（CI 不可用、需发布非 main 提交时）。

1. 触发：`Web checks` 在 main 的 push 上成功（`workflow_run`），或在 main 上手动 `workflow_dispatch`。并发组 `production-deploy` 不取消在跑的发布，排队只留最新一次。
2. `target`：[`scripts/ci-deploy-target.sh`](../../scripts/ci-deploy-target.sh) 判定。提交不是 `origin/main` 最新、或任一 API 已运行其后代提交（不回退）则跳过；两套 API 都已是该提交时自动触发跳过，手动触发照常重发（私有 overlay 单独更新用这个）。跳过记 notice，不算失败。
3. `backend`：检出该提交，用 deploy key 克隆私有仓库 main HEAD 到 `private/`，`GITHUB_TOKEN` 登录 GHCR，执行 `build-vps-release.sh all $RUNNER_TEMP/aip-<公开12位>-<私有12位>`；再 `tar | ssh` 交给 VPS 上的 forced command，输出与退出码回传到 job。
4. `pages`：先轮询两套 API `/health` 的 `version`（内部版 `<公开sha>`，付费版 `<公开sha>+<私有sha>`，最长 300 秒），再无 `private/` 发布内部版、克隆同一私有提交后发布付费版，最后发后台前端（`pages-release.sh internal|paid|admin`，含域名 `version.json` 校验）。
5. 部署日志 `by=github-actions/run-<run_id>`；手动发布仍记 `user@host`（`DEPLOY_ACTOR` 可覆盖，写入时空白等字符换成 `-`）。

### Secrets（仓库 `Muluk-m/ai-image-playground`）

| Secret | 用途 |
| --- | --- |
| `PRIVATE_OVERLAY_SSH_KEY` | 私有仓库只读 deploy key |
| `VPS_SSH_KEY` / `VPS_SSH_KNOWN_HOSTS` / `VPS_SSH_HOST` / `VPS_SSH_USER` | 连接 VPS 的受限 key、主机公钥、地址、用户（`ubuntu`） |
| `PAGES_ENV` | 完整 `pages.env`；API 地址也从中读取 |
| `INTERNAL_CLOUDFLARE_API_TOKEN` / `PAID_CLOUDFLARE_API_TOKEN` | Pages 上传令牌，CI 写成 `$RUNNER_TEMP` 下 0600 文件，覆盖 `*_CLOUDFLARE_TOKEN_FILE` |

`PAID_EXTRA_ASSETS_DIR` 在 CI 改指 `private/pages-assets/`（`contact-qr.jpg`、`pay-qr.jpg`），目录缺失即失败。GHCR 推送用 workflow 的 `GITHUB_TOKEN`（`packages: write`）；包须允许本仓库 Actions 写入。任一必需 secret 为空，对应 job 首步报错退出。

### VPS 受限入口

[`scripts/ci-receive.sh`](../../scripts/ci-receive.sh) 安装为 `/home/ubuntu/bin/aip-ci-receive`（0755），`~/.ssh/authorized_keys` 一行：

```text
command="/home/ubuntu/bin/aip-ci-receive",restrict ssh-ed25519 AAAA… github-actions-deploy
```

只接受 `deploy <aip-12位hex-12位hex> <internal|paid|all> <run_id>`，其余一律拒绝（退出码 2）。stdin 的 tar 仅限相对路径的普通文件和目录（拒绝绝对路径、`..`、隐藏项、链接，上限 64 MiB），解到 `~/releases/<release-id>`；同一提交重发（手动触发）时原目录保留供回滚，改解到 `<release-id>.run-<run_id>`，解包失败会清理。然后以 `DEPLOY_ACTOR=github-actions/run-<id>` 运行包内 `vps-deploy.sh` 并透传退出码；发布失败时目录改名为 `….failed-run-<run_id>` 留作排查，可直接重跑 workflow。脚本更新后须重新安装。

## 前端：两套 Pages（手动应急）

构建和上传可在本机执行，资源紧张时改用 macmini2；两套串行发布。仅修改前端时发布两套 Pages，无需部署 VPS 后端。

| 形态 | Pages project | 网页 / API |
| --- | --- | --- |
| 内部版 | `ai-image-playground-internal` | `image-playground.qiliangjia.one` / `image-api.qiliangjia.one` |
| 付费版 | `ai-image-playground` | `muvloom.online` / `api.muvloom.online` |
| 付费旧域名 | 同一付费项目 | `image.nainma.online` / `api.nainma.online` |
| 后台 | `muvloom-admin` | `admin.muvloom.online` / `admin-api.muvloom.online` |

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

## 后台：前端在 Pages、API 在 VPS

后台前端是 `apps/admin` 的 Vite 产物，跟付费站同一个 Cloudflare 账号、同一份 `private/` overlay，发到独立项目 `muvloom-admin`；
后台服务端还是 compose 里的 `admin` 容器，只出 API，经 tunnel 暴露成 `admin-api.muvloom.online`。
两个域名同站（eTLD+1 相同），所以 `SameSite=Lax` 的 `admin_session` cookie 在 `fetch(credentials:'include')` 和 `<img>` 上都带得过去；`*.pages.dev` 预览域登不上，与主站一致。

日常发布不用管它：`deploy.yml` 的 `pages` job 在付费站之后自动跑 `pages-release.sh admin`。应急手动发布：

```sh
export PAGES_ENV_FILE=/absolute/protected/pages.env
cd /absolute/paid-checkout   # 必须带已验证的 private/
./scripts/pages-release.sh admin
```

一次性切换（已执行过就不用再来）按顺序：

1. `cloudflared tunnel route dns image-playground-paid admin-api.muvloom.online`，ingress 加 `admin-api.muvloom.online → http://admin:37378`，重启 cloudflared。
2. `app.env` 加 `ADMIN_FRONTEND_ORIGIN=https://admin.muvloom.online`、`ADMIN_CORS_ALLOWED_ORIGINS=https://admin.muvloom.online`，把 `ADMIN_PUBLIC_ORIGIN` 改成 `https://admin-api.muvloom.online`（它是 API 自己的 origin，Google 控制台的回调地址跟着改成 `https://admin-api.muvloom.online/api/auth/google/callback`），删掉 `ADMIN_DIST_DIR` 那一行。
3. `app-compose.sh compose image-playground-paid up --detach --no-deps admin`，验 `https://admin-api.muvloom.online/health` 的 `version`。
4. 建 Pages 项目并首发，再把 `admin.muvloom.online` 的 DNS 从 tunnel 切到 Pages，删掉 ingress 里旧的 `admin.muvloom.online` 那行。Cloudflare Access 两个域名都要覆盖。
5. 浏览器验收：登录、任务详情里的图片（跨域带 cookie）、私有计费面板、灵感库。

回滚：DNS 切回 tunnel、恢复 ingress 那一行即可；镜像里保留了带 dist 的一版 admin，`ADMIN_DIST_DIR` 留空时用镜像内默认值仍能自托管前端。

灵感库首次上线还要跑一次导入（幂等，重跑只补新条目）：

```sh
DATABASE_URL=<迁移账号> bun run apps/bff/scripts/import-inspirations.ts
```

它把 `apps/web/public/inspiration-manifest.json` 的 563 条导成已发布条目（22 个分类），封面先沿用原外链。
后台上传封面要 `PUBLIC_ASSET_BUCKET` / `PUBLIC_ASSET_BASE_URL`（见 `deploy/app.*.env.example`）；两个都空时后台只能引用外链，已发布内容不受影响。

## 测试环境（test 分支预览）

只发前端。push 到 `test` 分支触发 [`.github/workflows/test-preview.yml`](../../.github/workflows/test-preview.yml)：构建不含私有 overlay 的内部版前端，`runtime-config.json` 指向 `PAGES_ENV` 里的 `INTERNAL_BFF_BASE_URL`，再以 `pages-deploy.sh public <内部版项目> test` 上传到内部版 Pages 项目的预览别名。不构建、不发布后端。

| 项 | 值 |
| --- | --- |
| 触发 | push 到 `test`；或 Actions → `Test preview` → Run workflow 选分支 |
| 地址 | `https://test.ai-image-playground-internal.pages.dev`（别名固定，后一次发布覆盖前一次；job summary 另给本次部署的一次性地址） |
| API | `image-api.qiliangjia.one`，即内部版生产 API |
| Secrets | 复用 `PAGES_ENV`、`INTERNAL_CLOUDFLARE_API_TOKEN`，无新增 |

`test` 分支上必须带着这个 workflow 文件（从 main 派生即可）才会触发。并发组 `test-preview` 取消排队中的旧 run。`Web checks` 现在也在 `test` 的 push 上跑，但它在 `test` 上成功不会引出生产发布：[`deploy.yml`](../../.github/workflows/deploy.yml) 的 `workflow_run` 限 `branches: [main]`，手动触发限 `github.ref == 'refs/heads/main'`。预览发布也不碰生产分支 `main` 和三个自定义域名，因此不做 `version.json` 轮询，上传成功即结束。

数据是内部版生产的真实数据：账号、积分、任务队列与对象存储都与 `image-playground.qiliangjia.one` 同一份，上游调用照常计费。预览站不做删除、批量提交、结算相关的破坏性操作。与生产的另两处差异：不带私有 overlay（付费版能力和 `pages-assets` 都不在）；后端始终是 main 上已发布的那一版，前端若依赖尚未上线的 BFF 接口会直接失败。

### 首次使用前的人工步骤

1. **放行 API 的 CORS**，否则预览站一个接口也调不通。`CORS_ALLOWED_ORIGINS` 是精确白名单（[`apps/bff/src/config.ts`](../../apps/bff/src/config.ts) 的 `corsOriginList`、[`apps/bff/src/app.ts`](../../apps/bff/src/app.ts) 的 `cors({ origin, credentials: true })`）。2026-09-19 实测：带 `Origin: https://image-playground.qiliangjia.one` 的预检返回该 origin，带预览 origin 的预检不返回任何 `access-control-allow-origin`。在 VPS 上编辑 `~/.config/ai-image-playground/apps/image-playground-internal/app.env`，把预览 origin **追加**在现有值之后（列表第一项是 `AUTH_FRONTEND_ORIGIN` 为空时 OAuth 回跳的默认前端，内部版虽已显式设该变量，顺序仍不要动）：

```sh
CORS_ALLOWED_ORIGINS=https://image-playground.qiliangjia.one,https://test.ai-image-playground-internal.pages.dev
```

`app.env` 是 compose 的 `env_file`，整份注入容器，`restart` 不重读，改完执行一次完整发布：

```sh
cd <VPS 上的检出> && ./scripts/app-compose.sh up image-playground-internal
```

2. **放行对象存储的 CORS**，只影响云端项目的媒体上传与读取。前端拿预签名 URL 直接 `PUT`/`GET`（`apps/web/src/features/canvas/lib/projectMedia.ts`、`apps/web/src/lib/cloudMedia.ts`，均 `credentials: 'omit'`），bucket 白名单里没有预览域名。要验这部分功能，就在 R2 bucket 的 CORS 规则里加上 `https://test.ai-image-playground-internal.pages.dev`；仓库里的 [`deploy/r2-media-cors.json`](../../deploy/r2-media-cors.json) 是该策略的副本，没有脚本自动下发，两边都要改。

### 预览站不支持登录

会话 cookie `image_playground_session` 是 `httpOnly; Secure; SameSite=Lax; path=/`，host-only 发在 API 域上（[`apps/bff/src/lib/user-session.ts`](../../apps/bff/src/lib/user-session.ts)）。`test.<项目>.pages.dev` 与 `qiliangjia.one` 不是同一注册域，浏览器对 `credentials: 'include'` 的跨站请求不带 Lax cookie：CORS 放行之后无需登录态的接口可用，登录、积分、云同步、云端历史一概用不了；OAuth 回跳去的是 `AUTH_FRONTEND_ORIGIN`（生产站），也落不回预览站。要验证这些流程用本地 dev 或生产站，不要为了预览把 cookie 改成 `SameSite=None`。

## 后端：镜像构建与发布（手动应急）

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

接收脚本持有发布锁，校验 `SHA256SUMS`（须覆盖目录内全部文件，多出未列文件即拒绝），按 digest `docker pull` 并打回本地标签，再校验本地镜像确实带着该 digest（不比镜像 ID：构建机若用 containerd 存储，ID 与 VPS 上的不可比）、架构、`APP_VERSION`、原生依赖，最后执行兼容迁移与启动；保留 VPS 原有运行配置。任一镜像拉取或校验失败都不改动服务。CI 部署失败时，入口把该发布目录改名为 `<id>.failed-run-<run_id>` 留作排查，同一提交可直接重跑。

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
   路由转发保留公开 `Host`，供登录交接等按域名校验的接口使用；上游连接地址只取 `route.json`，不使用客户端提供的 `Host` 或 `X-Forwarded-Host` 选择上游。
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
