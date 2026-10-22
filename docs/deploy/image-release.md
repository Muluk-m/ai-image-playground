# 部署手册

前端由 Pages 托管，后端镜像经私有 GHCR 送到 VPS，VPS 仅运行预构建镜像。禁止在 VPS 安装构建依赖、编译或执行 `docker build`。

## 产品版本

线上版本是 `MAJOR.MINOR.PATCH`。唯一需要手改的是仓库根 `package.json` 的 `version`：只改主版本或次版本，并把补丁写成 `0`（现在是 `0.4.0`）。每次从 main 真正发出去的生产部署都会打一个标签，补丁在该 `vMAJOR.MINOR.*` 上加一。主版本或次版本和最新标签不是同一条线时，从 `.0` 重新计。标签是补丁的来源，部署不会把新版本提交回 main，以免再次触发自己。

设置里的 `v…` 来自这次部署注入的 `APP_RELEASE`。本地和 PR 构建没有这个变量，显示根 `package.json` 里的 `MAJOR.MINOR.0`。`/health` 的 `version` 仍是提交号（付费版再加私有提交）；产品版本在旁边的 `release` 字段。

## 默认：合并 main 即部署

负责人决定（2026-09-18）：会话只负责合并到 `main`，不再手动发布；部署由 [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) 完成。下文手动步骤仅作应急（CI 不可用、需发布非 main 提交时）。

1. 触发：`Web checks` 在 main 的 push 上成功（`workflow_run`），或在 main 上手动 `workflow_dispatch`。main 上的 `Web checks` 先由 `prior` 核对：提交与其同仓 PR 头的代码树相同、且该 PR 头的 `Web checks` 已通过时，其余检查跳过（结论仍为 success），直接进入部署；PR 落后于 main、来自 fork 或找不到通过记录时照常全跑。并发组 `production-deploy` 不取消在跑的发布，排队只留最新一次。
2. `target`：[`scripts/ci-deploy-target.sh`](../../scripts/ci-deploy-target.sh) 判定。提交不是 `origin/main` 最新、或任一 API / 站点已运行其后代提交（不回退）则整单跳过。三边各自和自己线上的提交比：API 读两套 `/health`，内部站与收费站读各自的 `/version.json`，Admin 站读自己的 `/version.json`。C 端包（`apps/web`、`apps/website`、`packages/shared`）自那以后变了才发内部站和收费站并跑浏览器冒烟，Admin 包（`apps/admin`、`packages/shared`）变了才发 Admin 站，API 树没变就跳过镜像。lockfile 变动只算作实际安装这些依赖的一边有变：[`scripts/lock-closure-changed.mjs`](../../scripts/lock-closure-changed.mjs) 对比两次提交中该边 importer（含链接到的 workspace 包）可达的全部包快照，只加前端依赖不会重建 API 镜像；读不到或解析失败按有变处理。某一边被上次跳过，它的版本就停在旧提交，下次仍会补发；已经发过的一边不会因为别的边落后而重发。版本读不到或几份副本不一致的一边照常发布。三边都没变、或都已在跑这个提交时，自动触发跳过，手动触发照常重发（私有 overlay 单独更新用这个）。跳过记 notice，不算失败。
3. `release`：在同一个 `production-deploy` 并发组里根据根 `package.json` 的主次版本和已有 `vMAJOR.MINOR.*` 标签算出下一个补丁，打上 `vMAJOR.MINOR.PATCH` 并推送，避免两次发布抢同一个补丁。不把版本提交回 main。
4. `backend`：仅在 API 树有变化时检出该提交，用 deploy key 按 `private.lock` 钉住的提交检出私有仓库到 `private/`，`GITHUB_TOKEN` 登录 GHCR，执行 `build-vps-release.sh all $RUNNER_TEMP/aip-<公开12位>-<私有12位>`（带上 `APP_RELEASE`）；再 `tar | ssh` 交给 VPS 上的 forced command，输出与退出码回传到 job。
5. `pages`：API 这次有发布时，每个站先轮询自己对应 API `/health` 的 `version`（内部版 `<公开sha>`，付费版 `<公开sha>+<私有sha>`，最长 300 秒）。API 被跳过时不等待。然后内部版（无 `private/`）与付费版（克隆同一私有提交）两个 job 并行构建发布，各自用 Chromium 验收自己的生产站；两者结束后 `admin-pages` 再发后台前端（`pages-release.sh internal|paid|admin`，含域名 `version.json` 校验）。两站互不阻塞：一边失败不撤回另一边已发布的站点。构建时的 `APP_RELEASE` 写进设置里的版本号。
6. 部署日志 `by=github-actions/run-<run_id>`；手动发布仍记 `user@host`（`DEPLOY_ACTOR` 可覆盖，写入时空白等字符换成 `-`）。

### 前端启动验收

`pages-release.sh` 对 web 发布除版本清单外，还以普通 URL（不加绕缓存参数）核验首页与深链接的 HTML 内容标识（整份 HTML 的 sha256，含独立启动脚本）、所有构建 JS/CSS 的 MIME 与字节内容，以及不存在的 `/assets/*.js` 返回 404 且不得长期缓存。CDN 传播期间在 180 秒内有界重试，仍用普通 URL；超过期限仍不一致则退出非零，不记成功。生产 workflow 随后用无登录态 Chromium 打开两套生产站，确认匿名官网（未启用登录时直接进入工作台）、双语指南、登录入口与隔离的本地项目画布挂载、启动遮罩消失且无 JavaScript 异常。

PR/main/test 的公开版与带 overlay 构建都在 Chromium 中冷启动官网、`/image` 工作台和项目深链接；工作台未挂载、启动遮罩未消失、JS 异常或分片加载失败均阻止检查通过。`pages-release.sh` 调用的上传入口还会在构建与附加资源复制后，对最终 `dist` 重跑同一检查，通过后才执行 Wrangler 上传，不以重新构建替代已测产物。发布后继续验证两个生产域名的真实加载。

浏览器运行时由 `scripts/pages-browser-smoke.sh` 在仓库外准备固定版本 Playwright；手动应急发布也必须通过该检查。本地产物检查按 `_redirects` 提供路由，保留缺失资源 404；项目直链使用隔离浏览器内预置的本地画布，首次导航前不加载任何应用模块。检查只 mock 匿名启动所需的只读 API 并阻止其它外部请求；不连接生产 API、不调用付费生成。它验证生产分片的真实求值与启动，不替代登录、业务数据及生成验收。失败时保存截图、原始 JS/资源错误和页面 HTML，CI 上传为七天保留的 artifact。

静态资源缺失不得回退首页：web 使用顶层 `404.html` 关闭 Pages 默认 SPA 回退，`_redirects` 只列真实业务路由，构建时由 `apps/web/src/lib/pagesRedirects.ts` 从 `appPaths.ts` 生成，新增入口只改 `appPaths.ts`。`/assets/*` 使用一年 `immutable`：Pages 的 `_headers` 不作用于 404，发布校验也会确认缺失资源返回不可复用的 404；前提是不恢复全站 SPA 回退。资产页路由同样是 `/assets`：带斜杠的 `/assets/` 落在这条规则里，只做 301 跳到 `/assets`，不回退 SPA；发布校验会拒绝带长缓存的业务深链。

Admin（`apps/admin`）同样带顶层 `404.html`，`_redirects` 由 `apps/admin/src/lib/pagesRedirects.ts` 在构建时从 TanStack Router 生成的 `routeTree.gen.ts` 逐条列出（含私有覆盖层的路由），回退目标写 `/`，不写 `/index.html`。`pages-release.sh admin` 发布后同样跑 `verify-pages-release.mjs`（`admin` 模式）：首页和每条深链返回本次构建的 HTML 且不长缓存，所有 JS/CSS 字节一致，缺失的 `/assets/*.js` 返回不可复用的 404。

2026-10-01 启动故障的错误脚本缓存已单 URL 清除。独立内联脚本在入口脚本、必需样式或分片（`vite:preloadError`）加载失败时，自动用带 `__aip_reload` 时间戳的当前页面 URL 重载一次，让 HTML 重新获取对应版本的哈希资源；同一次失败会话中，同源 `/assets/` 的入口或必需样式再次失败时，最多等待 20 秒，每 2 秒探测原始资源 URL（单次最多 5 秒）；构建时记录入口的静态依赖分片和关联 CSS（不包含动态懒加载分片），它们和已报告失败的资源均返回 200、正确 JS/CSS MIME 和非空内容后再刷新一次。两次自动恢复的预算均写入 sessionStorage，跨重载保留且不按时间过期；只有用户显式点击重试才重置预算；首次 React 渲染可能只是登录或加载页，不恢复预算，以免后续懒加载分片持续失败造成刷新循环。持续失败、离线或 sessionStorage 不可写时显示重试，避免循环刷新。同一 CSS 的 link 错误和 Vite 预加载错误共用既有探测期限；仅匹配实际失败的同一资源，无关分片错误仍正常处理。探测不修改资源 URL，不把 SPA HTML 当成资源恢复。按钮也使用新的 HTML URL，保留原路径、其他查询参数和 hash，首次 React 渲染后移除恢复参数；不清理账号、IndexedDB 或用户作品。30 秒仍未渲染时显示重试并禁止晚到的失败事件触发自动导航；随后成功渲染仍可撤下超时面板。React 渲染后的业务加载与错误由应用接管。外部字体样式独立、非阻塞加载，失败回退系统字体，不再触发启动失败。

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

### 付费站默认域名跳转

付费 Cloudflare 账号的 Bulk Redirect List `muvloom_pages_canonical` 将
`ai-image-playground.pages.dev/` 以 301 跳转到 `https://muvloom.online/`，由账号级
`http_request_redirect` ruleset 的同名规则启用。开启 `subpath_matching`、
`preserve_path_suffix`、`preserve_query_string`；`include_subdomains=false`，不影响部署预览子域名。

这是账号配置，不在 Pages 构建产物中；Pages 常规发布不会覆盖它。更换付费 Pages 项目或
`PAID_PUBLIC_ORIGIN` 时同步核对这条规则。不要给默认域名放宽 API CORS：正式域名承载现有登录会话。
维护已有 ruleset 时只更新该规则，不覆盖账号中的其他规则；回滚时只禁用同名规则。

验收根路径、`/guide/en/?from=redirect-check` 和项目深链接均保留原路径与参数，浏览器跳转后仍保留锚点，
正式站能读取能力接口并正常展示登录状态。Cloudflare 的 `_redirects` 不支持域名级匹配，
该配置采用官方 [Pages 默认域名跳转流程](https://developers.cloudflare.com/pages/how-to/redirect-to-custom-domain/)。

### 手动构建与发布

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
4. 用付费账号凭证给公开素材桶应用浏览器直传 CORS：`npx wrangler r2 bucket cors set "$PUBLIC_ASSET_BUCKET" --file deploy/r2-public-assets-cors.json`，再用 `npx wrangler r2 bucket cors list "$PUBLIC_ASSET_BUCKET"` 确认 Admin 可 `GET` / `HEAD` / `PUT`，主站、内部站与测试站只可 `GET` / `HEAD`。主站套用图生图灵感时会从浏览器读取原图，因此读权限必须覆盖主站 origin。
5. 建 Pages 项目并首发，再把 `admin.muvloom.online` 的 DNS 从 tunnel 切到 Pages，删掉 ingress 里旧的 `admin.muvloom.online` 那行。Cloudflare Access 两个域名都要覆盖。
6. 浏览器验收：登录、任务详情里的图片（跨域带 cookie）、私有计费面板、灵感库封面上传。

回滚：DNS 切回 tunnel、恢复 ingress 那一行，并从 `app.env` **删除** `ADMIN_DIST_DIR`（不能留空）；镜像内默认值 `/app/apps/admin/dist` 才会恢复自托管前端。

灵感库首次上线还要跑一次导入（幂等，重跑只补新条目）：

```sh
DATABASE_URL=<迁移账号> bun run apps/bff/scripts/import-inspirations.ts
```

它把 `apps/web/public/inspiration-manifest.json` 的 563 条导成已发布条目（22 个分类），封面先沿用原外链。
后台上传封面要 `PUBLIC_ASSET_BUCKET` / `PUBLIC_ASSET_BASE_URL`（见 `deploy/app.*.env.example`），并先应用 `deploy/r2-public-assets-cors.json`；两个变量都空时后台只能引用外链，已发布内容不受影响。

## 测试环境（test 分支）

只发前端。push 到 `test` 分支由 [`.github/workflows/deploy-test.yml`](../../.github/workflows/deploy-test.yml) 发布到 https://test.muvloom.online，流程、数据范围与首次配置见[测试环境手册](test-environment.md)。原先的 `test-preview.yml`（内部版 Pages 预览别名）已删除。

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

每套最多两代执行器，包括当前代和一代尚未退役的旧实例或失败候选。规则见 [ADR 0009](../adr/0009-preserve-executors-during-rollout.md) 的 2026-10-18 修订。VPS 使用 coreutils `timeout` 给 Docker 状态查询和控制请求设限。`rollout-runtime.sh` 按以下顺序发布：

1. 校验 `releases/route.json` 指向的 BFF 与 worker，重建派生文件 `current`。先恢复当前 worker 的 activation marker、resume 与 restart policy，再检查容量。
2. 安全回收非当前执行器。仍有忙碌、结算失败或未知实例时，不同镜像发布在迁移和创建容器之前返回 `deployment_capacity_blocked`。当前代继续接单。同镜像重跑核对两个当前容器的不可变 Image ID 与健康状态，只收敛清理和配套服务。
3. 运行兼容迁移，启动新 BFF 与暂停接单的新 worker，确认健康。当前 BFF 继续接单。
4. 准备稳定的 `release-router`，检查隧道指向路由。路由替换可能中断客户端连接，客户端重连后仍按 owner origin 找到原执行器。路由保留公开 `Host`，上游地址只取 `route.json`。
5. 先禁用旧 worker 自动重启并取得 drain 确认，再启用新 worker。原子替换 `route.json` 即完成切换，随后更新 `current`。两文件之间发生中断时，以 route 为准。
6. 在共享的 `DEPLOY_DRAIN_DEADLINE_SECONDS` 等待预算内回收已排空的旧实例，默认 300 秒，控制请求的耗时也计入。到期仍忙或未知的实例继续运行，保留原名称、网络和 owner origin。输出 `Retained <name>: <reason>`，继续更新 admin、host-collector 与 pg-backup。配套服务完成后发布返回 0。

只有完整的 drain 响应可以授权停止运行中的执行器。响应必须包含布尔 `draining=true`、整数 `active=0` 与布尔 `safeToStop=true`；BFF 还须有 `failed=false`。脚本先设置 `restart=no`，再取 drain 证明，并复核容器 ID 与 StartedAt 没变。只有满足这些条件才发送 SIGTERM，宽限为 `DEPLOY_STOP_GRACE_SECONDS`，默认 75 秒，之后使用普通 `docker rm`。停止失败不会升级为强删。

- BFF 结算失败、控制请求失败、字段缺失、inspect 失败和进程身份变化都会保留实例。取该实例日志，按业务核查流程处理；不要为了腾出发布槽位删除它。
- 新 worker 的 `safeToStop` 计入未完成的 private maintenance。首次升级时，旧 worker 仍只提供原有 queue、analysis 与 batch 排空证明，不能把新字段当成旧版本已经完成所有维护写入的证据。旧 worker 的信号退出路径另行等待 private maintenance。
- 验收两套 API、版本、当前与保留容器、备份、登录和业务数据。每套允许保留一代在途实例。涉及执行器切换时，验证新任务进入新实例，旧任务跨等待期限仍继续，刷新可续接，上游调用和结算不重复。
- 两代执行器的池上限之外，还要核算日志、admin、测试、备份与迁移连接。仅发布后端不重发 Pages，不更新共享源码目录。

### 旧协议实例与 `legacy-origin`

没有 drain 接口的旧 Compose BFF 或 worker 不能证明安全退休。旧 queue 数据库 gate 也不能证明免费 Agent 对话空闲。发现这些实例时，发布保留容器与 `legacy-origin`，在迁移或创建第三代之前失败。`DEPLOY_RETIRE_LEGACY=1` 不再绕过安全证明。

不得用近期无日志、空付费任务表或延长 SIGTERM 宽限代替排空证明。旧协议实例需要独立的运行证据与退休方案；普通发布不负责强制清除它。

## 回滚与失败处理

使用包含本次安全修复的发布目录执行回滚，并指定已验证的旧镜像：

```sh
scripts/app-compose.sh rollback <project> <旧镜像>
```

回滚与发布使用同一容量和退休规则。保留旧代仍忙时，回滚可能被阻塞。禁止执行 `compose up --force-recreate` 或 `compose down` 绕过检查，也不要调用历史发布目录里的旧强停脚本。数据库不自动回滚；迁移须兼容新旧版本。

切换前失败时，脚本恢复旧 worker 接单与 activation marker，并通过同一退役检查清理本次候选。新 BFF 可能已经拾取 inbox，新 worker 可能已经开始任务；忙碌候选继续运行并占用保留槽位。切换后即使 `current` 尚未写入，也保护 route 指向的新一代。配套服务失败时，重跑同镜像完成剩余步骤，不再创建一代。

不手工修改 `current`、`route.json`、`activated/` 或 `legacy-origin`。route 缺失或损坏且仍有受管容器时，脚本保留实例并报告错误，不能回退到首次安装。部署锁记录进程身份，后续重跑可以回收已退出进程留下的锁；无法确定持有者的旧锁继续阻塞。

运行中镜像不得删除。回滚优先使用 VPS 本地保留的镜像。本地镜像缺失时，由当前安全发布工具按已验证 digest 重新拉取，再执行回滚。GHCR 镜像清理不属于本流程。

旧的 `vps-deploy.sh all [git-ref]` 不再适用，必须传发布目录；VPS 旧检出中的入口脚本也须保持更新，防止绕回源码构建。备份、恢复及旧备用启停见[灾备手册](cold-recovery.md)。
