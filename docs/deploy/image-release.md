# 部署手册

前端由 Pages 托管，后端镜像经私有 GHCR 送到 VPS，VPS 仅运行预构建镜像。禁止在 VPS 安装构建依赖、编译或执行 `docker build`。

## 产品与现存标识

产品为 **muvloom**：所有生产网页域名共用一个 Pages 项目和一个后端；企业域名保留自己的第一方 API 别名及按 origin 配置的登录策略。测试环境使用独立 Pages、后端、数据库和存储。

Pages 发布入口为 `muvloom|test|admin`；后端生产目标只有 `paid`，另有隔离目标 `test`。配置示例为 `app.muvloom.env.example` 和 `operator-config.muvloom.example.json`。旧部署目标与兼容入口已经移除，不再作为发布或恢复路径。

以下名称连接现存物理资源，继续保留，不能仅改默认值以免生成空卷或孤立服务：

| 现存标识 | 用途 |
| --- | --- |
| `PAID_*`、`PAID_CLOUDFLARE_API_TOKEN` | muvloom 生产 Pages 与后端配置、上传令牌 |
| VPS 目标 `paid`、`images.tsv` 的 `paid` 行 | muvloom 生产后端与私有 overlay |
| `image-playground-paid`、`apps/image-playground-paid` | 生产 Compose project、容器、网络、卷及仓库外配置路径 |
| 镜像 tag、R2 对象前缀、Tunnel 和 Pages 项目名 | 保留已在使用的存储、服务发现及回滚资源 |
| `OPS_DEPLOYMENT_NAME=paid` | VPS 部署日志和告警；Pages 日志使用 `muvloom-web` / `muvloom-admin` |

计费状态 `paid`、业务内部 API `/internal/*` 与 `INTERNAL_API_TOKEN` 保持业务含义。历史事故中的旧部署名称保留为历史事实，不表示仍有第二个生产发布目标。

### 仓库外更新前提

这些步骤须由获准的运维人员执行；本次仓库清理没有修改线上配置或验证线上状态：

- 在 GitHub `PAGES_ENV` 及每台发布机的仓库外 `pages.env` 中，将企业映射键改为 `ENTERPRISE_PUBLIC_ORIGIN` / `ENTERPRISE_BFF_BASE_URL`，保留原域名与 API 值。读取代码没有旧键 fallback；必须与本次代码一起准备。`PAID_*` 继续保留。
- 在 VPS 备份并更新固定 `/home/ubuntu/bin/aip-ci-receive` 与完整 `~/deploy-runtime`，生产受限 key 仍绑定 `release` 范围，测试 key 仍绑定 `test` 范围；新 receiver/runtime 只允许对应的 `paid` / `test`。安装后由维护者完成语法、作用域隔离及恶意包拒绝验收，不能只更新仓库副本。
- 同步仓库外 `deploy.env`，删除旧部署 project/image 配置；`SEGMENTER_EDITIONS` 仅使用 `paid` / `test`。不改现存 `PAID_PROJECT`、`PAID_IMAGE`、数据库、卷或对象前缀。


## 产品版本

线上版本是 `MAJOR.MINOR.PATCH`。唯一需要手改的是仓库根 `package.json` 的 `version`：只改主版本或次版本，并把补丁写成 `0`（现在是 `0.4.0`）。每次从 main 真正发出去的生产部署都会打一个标签，补丁在该 `vMAJOR.MINOR.*` 上加一。主版本或次版本和最新标签不是同一条线时，从 `.0` 重新计。标签是补丁的来源，部署不会把新版本提交回 main，以免再次触发自己。

设置里的 `v…` 来自这次部署注入的 `APP_RELEASE`。本地和 PR 构建没有这个变量，显示根 `package.json` 里的 `MAJOR.MINOR.0`。`/health` 的 `version` 仍是提交号（muvloom 版再加私有提交）；产品版本在旁边的 `release` 字段。

## 默认：合并 main 后按窗口部署

负责人决定（2026-09-18）：会话只负责合并到 `main`，不再手动发布；部署由 [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) 完成。下文手动步骤仅作应急（CI 不可用、需发布非 main 提交时）。

1. 触发：`schedule` 窗口，北京时间 12:30、18:30、23:30（cron UTC `30 4,10,15 * * *`），只发当时 `origin/main` 的 tip，且该提交的 `Web checks` 须已在 main 上成功，未完成或失败则跳过本窗口（notice，不报错）；overlay-bump 用 `GITHUB_TOKEN` 推的 lock 提交没有 `Web checks`，改看其父提交。紧急通道是在 main 上手动 `workflow_dispatch`，必填 `reason`（写入 job summary），全量重发，用于紧急修复与 overlay 即时发布。main 上的 `Web checks` 先由 `prior` 核对：提交与其同仓 PR 头的代码树相同、且该 PR 头的 `Web checks` 已通过时，其余检查跳过（结论仍为 success），直接进入部署；PR 落后于 main、来自 fork 或找不到通过记录时照常全跑。并发组 `production-deploy` 不取消在跑的发布，排队只留最新一次。
2. `target`：[`scripts/ci-deploy-target.sh`](../../scripts/ci-deploy-target.sh) 判定共享 muvloom API、muvloom Pages 项目（企业域名与 muvloom 域名共用）、Admin 是否需要发布。前端扫描 `PAID_PUBLIC_ORIGIN` 的 `/version.json`，同一项目的其他域名随之更新。提交不是 `origin/main` 最新、或任一受管 API / 站点已运行其后代提交（不回退）则整单跳过；版本读不到或副本不一致照常发布。
3. `release`：在同一个 `production-deploy` 并发组里根据根 `package.json` 的主次版本和已有 `vMAJOR.MINOR.*` 标签算出下一个补丁，打上 `vMAJOR.MINOR.PATCH` 并推送，避免两次发布抢同一个补丁。不把版本提交回 main。
4. `backend`：仅在 API 树有变化时检出该提交，用 deploy key 按 `private.lock` 钉住的提交检出私有仓库到 `private/`，`GITHUB_TOKEN` 登录 GHCR，构建发布目录并经 forced command 执行 `deploy <id> paid <run_id>`，更新共享 muvloom 后端。
5. `pages-muvloom`（显示名 `Pages (muvloom project, every product domain)`）→ `admin-pages`：一个项目、多个域名。只构建、上传一次 muvloom Pages 项目，`muvloom.online`、`image.nainma.online` 与企业域名 `image-playground.qiliangjia.one` 共用产物。`pages-release.sh muvloom` 把 `ENTERPRISE_PUBLIC_ORIGIN → ENTERPRISE_BFF_BASE_URL` 并入 `baseUrlsByOrigin`，并给企业域名追加按 host 生效的 `X-Robots-Tag: noindex, nofollow`。API 本次发布时，先等共享 muvloom API 与企业 API hostname `/health` 均报 `<公开sha>+<私有sha>`，再构建、上传并跑 Chromium 验收。企业域名在 Cloudflare 自定义域名列表中时，必须在 300 秒内与 muvloom 站 `version.json` 一致、带 noindex 头并通过 Chromium 验收，否则 job 失败；不在列表中时只给 warning，不代表企业域名已经交付。读不到域名列表也失败。前端单独发布时允许 backend job 跳过；Admin 等 `pages-muvloom` 成功或跳过。失败后只能按失败 job 重跑，不能重跑整单。
6. 部署日志 `by=github-actions/run-<run_id>`；手动发布仍记 `user@host`（`DEPLOY_ACTOR` 可覆盖，写入时空白等字符换成 `-`）。

### 前端启动验收

`pages-release.sh` 对 web 发布除版本清单外，还以普通 URL（不加绕缓存参数）核验首页与深链接的 HTML 内容标识（整份 HTML 的 sha256，含独立启动脚本）、所有构建 JS/CSS 的 MIME 与字节内容，以及不存在的 `/assets/*.js` 返回 404 且不得长期缓存。CDN 传播期间在 180 秒内有界重试，仍用普通 URL；超过期限仍不一致则退出非零，不记成功。生产 workflow 随后用无登录态 Chromium 打开 muvloom 与企业域名，确认匿名官网（未启用登录时直接进入工作台）、双语指南、登录入口与隔离的本地项目画布挂载、启动遮罩消失且无 JavaScript 异常。

PR/main/test 的公开版与带 overlay 构建都在 Chromium 中冷启动官网、`/image` 工作台和项目深链接；工作台未挂载、启动遮罩未消失、JS 异常或分片加载失败均阻止检查通过。`pages-release.sh` 调用的上传入口还会在构建与附加资源复制后，对最终 `dist` 重跑同一检查，通过后才执行 Wrangler 上传，不以重新构建替代已测产物。发布后继续验证两个生产域名的真实加载。

浏览器运行时由 `scripts/pages-browser-smoke.sh` 在仓库外准备固定版本 Playwright；手动应急发布也必须通过该检查。本地产物检查按 `_redirects` 提供路由，保留缺失资源 404；项目直链使用隔离浏览器内预置的本地画布，首次导航前不加载任何应用模块。检查只 mock 匿名启动所需的只读 API 并阻止其它外部请求；不连接生产 API、不调用付费生成。它验证生产分片的真实求值与启动，不替代登录、业务数据及生成验收。失败时保存截图、原始 JS/资源错误和页面 HTML，CI 上传为七天保留的 artifact。

静态资源缺失不得回退首页：web 使用顶层 `404.html` 关闭 Pages 默认 SPA 回退，`_redirects` 只列真实业务路由，构建时由 `apps/web/src/lib/pagesRedirects.ts` 从 `appPaths.ts` 生成，新增入口只改 `appPaths.ts`。`/assets/*` 使用一年 `immutable`：Pages 的 `_headers` 不作用于 404，发布校验也会确认缺失资源返回不可复用的 404；前提是不恢复全站 SPA 回退。资产页路由同样是 `/assets`：带斜杠的 `/assets/` 落在这条规则里，只做 301 跳到 `/assets`，不回退 SPA；发布校验会拒绝带长缓存的业务深链。

Admin（`apps/admin`）同样带顶层 `404.html`，`_redirects` 由 `apps/admin/src/lib/pagesRedirects.ts` 在构建时从 TanStack Router 生成的 `routeTree.gen.ts` 逐条列出（含私有覆盖层的路由），回退目标写 `/`，不写 `/index.html`。`pages-release.sh admin` 发布后同样跑 `verify-pages-release.mjs`（`admin` 模式）：首页和每条深链返回本次构建的 HTML 且不长缓存，所有 JS/CSS 字节一致，缺失的 `/assets/*.js` 返回不可复用的 404。

旧哈希保留：Pages 新部署只提供本次构建的文件，已打开的旧标签再懒加载上一版分片会 404。`pages-release.sh`（muvloom、test、admin）导出 `PAGES_ASSET_ORIGIN`，`pages-deploy.sh` 在浏览器冒烟和上传前运行 `scripts/retain-pages-assets.mjs`：读取线上 `assets-manifest.json`，把 14 天内最近 4 次发布在 `/assets`、`/website-assets` 下带内容哈希、而本次构建没有的文件从线上下载进 dist，再写出含本次在内最多 5 次发布的新清单。线上没有清单、清单读不到或个别文件取不到时只打警告，照常发布；漏掉的分片由客户端「同一份 HTML 自动刷新一次」兜底（启动守卫 `apps/web/src/boot/vitePlugin.ts`，工作台分片另有 `apps/web/src/lib/chunkLoad.ts`）。下载的文件必须非空且类型与扩展名一致；dist 将超过 15,000 个文件时从最旧的发布开始丢弃。旧分片会在后续发布里继续存在最多 14 天：需要立刻下掉某个旧文件（例如前端产物里误带了密钥）时，用 `PAGES_RETAIN_ASSETS=0` 应急发布一次，该次只发当次构建、不写清单，旧 URL 随即 404，之后的发布从新清单重新开始。

2026-10-01 启动故障的错误脚本缓存已单 URL 清除。独立内联脚本在入口脚本、必需样式或分片（`vite:preloadError`）加载失败时，自动用带 `__aip_reload` 时间戳的当前页面 URL 重载一次，让 HTML 重新获取对应版本的哈希资源；同一次失败会话中，同源 `/assets/` 的入口或必需样式再次失败时，最多等待 20 秒，每 2 秒探测原始资源 URL（单次最多 5 秒）；构建时记录入口的静态依赖分片和关联 CSS（不包含动态懒加载分片），它们和已报告失败的资源均返回 200、正确 JS/CSS MIME 和非空内容后再刷新一次。两次自动恢复的预算均写入 sessionStorage，跨重载保留且不按时间过期；只有用户显式点击重试才重置预算；首次 React 渲染可能只是登录或加载页，不恢复预算，以免后续懒加载分片持续失败造成刷新循环。持续失败、离线或 sessionStorage 不可写时显示重试，避免循环刷新。同一 CSS 的 link 错误和 Vite 预加载错误共用既有探测期限；仅匹配实际失败的同一资源，无关分片错误仍正常处理。探测不修改资源 URL，不把 SPA HTML 当成资源恢复。按钮也使用新的 HTML URL，保留原路径、其他查询参数和 hash，首次 React 渲染后移除恢复参数；不清理账号、IndexedDB 或用户作品。30 秒仍未渲染时显示重试并禁止晚到的失败事件触发自动导航；随后成功渲染仍可撤下超时面板。React 渲染后的业务加载与错误由应用接管。外部字体样式独立、非阻塞加载，失败回退系统字体，不再触发启动失败。

### Secrets（仓库 `Muluk-m/ai-image-playground`）

| Secret | 用途 |
| --- | --- |
| `PRIVATE_OVERLAY_SSH_KEY` | 私有仓库只读 deploy key |
| `VPS_SSH_KEY` / `VPS_SSH_KNOWN_HOSTS` / `VPS_SSH_HOST` / `VPS_SSH_USER` | 连接 VPS 的受限 key、主机公钥、地址、用户（`ubuntu`） |
| `PAGES_ENV` | 完整 `pages.env`；API 地址也从中读取 |
| `PAID_CLOUDFLARE_API_TOKEN` | muvloom Pages 账号的上传令牌，写成 `$RUNNER_TEMP` 下 0600 文件，覆盖 `PAID_CLOUDFLARE_TOKEN_FILE`。Admin 同样使用它。 |

`PAID_EXTRA_ASSETS_DIR` 在 CI 改指 `private/pages-assets/`（`contact-qr.jpg`、`pay-qr.jpg`），目录缺失即失败。企业域名与 muvloom 站是同一份产物，`/op/` 下的这些资源在企业域名上同样可访问（本就公开）。所有 `EXTRA_ASSETS_DIR` 内容都会公开发布，不可放密钥。GHCR 推送用 workflow 的 `GITHUB_TOKEN`（`packages: write`）；包须允许本仓库 Actions 写入。任一必需 secret 为空，对应 job 首步报错退出。

### VPS 受限入口

[`scripts/ci-receive.sh`](../../scripts/ci-receive.sh) 安装为 `/home/ubuntu/bin/aip-ci-receive`（0755）。`~/.ssh/authorized_keys` 里生产与测试各一把 key，权限范围写在 forced command 的参数里，调用方不能改：

```text
command="/home/ubuntu/bin/aip-ci-receive release",restrict ssh-ed25519 AAAA… aip-ci-deploy@github-actions
command="/home/ubuntu/bin/aip-ci-receive test",restrict ssh-ed25519 AAAA… aip-ci-deploy-test@github-actions
```

生产 key（secret `VPS_SSH_KEY`）范围 `release`，只接受 `deploy <aip-12位hex-12位hex> paid <run_id>`；测试 key（secret `VPS_SSH_KEY_TEST`，仅 `deploy-test.yml` 使用）范围 `test`，只接受目标 `test`。没有范围参数或范围不认识时拒绝一切；其余一律拒绝（退出码 2）。发布包是**数据包**，只允许 `SHA256SUMS`、`images.tsv` 和可选 `images.tar.gz`，上传 shell 脚本或 `scripts/` 目录直接拒绝。receiver 只执行 VPS 固定的 `~/deploy-runtime/scripts/vps-deploy.sh`，不执行发布包代码。stdin 的 tar 上限 64 MiB，解到 `~/releases/<release-id>`；同一提交重发时保留原目录，改解到 `<release-id>.run-<run_id>`，解包失败会清理。然后以 `DEPLOY_ACTOR=github-actions/run-<id>` 运行固定 runtime 并透传退出码；发布失败时目录改名为 `….failed-run-<run_id>` 留作排查。receiver 与固定 runtime 的安装更新是仓库外前提，见上文。

## 前端：一个 Pages 项目、多个域名（手动应急）

构建和上传可在本机执行，资源紧张时改用 macmini2。仅修改前端时只发布 muvloom Pages 项目（及按需 Admin），无需部署 VPS 后端。

| 形态 | Pages project | 网页 / API |
| --- | --- | --- |
| muvloom 版 | `ai-image-playground` | `muvloom.online` / `api.muvloom.online` |
| muvloom 旧域名 | 同一 muvloom 项目 | `image.nainma.online` / `api.nainma.online` |
| 企业域名（不收录） | 同一 muvloom 项目 | `image-playground.qiliangjia.one` / `image-api.qiliangjia.one` |
| 后台 | `muvloom-admin` | `admin.muvloom.online` / `admin-api.muvloom.online` |

所有域名使用同一份前端产物与同一个共享 muvloom runtime，但各自请求第一方 API hostname：企业域名的 `ENTERPRISE_BFF_BASE_URL=https://image-api.qiliangjia.one`，由外部路由接到共享 runtime。登录方式由后端按前端 origin 决定（`AUTH_LOGIN_METHODS_BY_ORIGIN`）：企业域名只开飞书，muvloom 开邮箱密码、邮箱注册与 Google；前端不按域名分支。不要把企业域名直接指向 `https://api.muvloom.online`：跨站请求不能携带 `SameSite=Lax` 会话 cookie。入口策略来自受保护的后端配置，不在公开源码写私有提供方细节。官网 canonical、hreflang、sitemap 与 `llms.txt` 都指向 `PAID_PUBLIC_ORIGIN`；企业域名靠 noindex 头排除收录。

### 企业域名与 API 别名

企业网页必须绑定到 muvloom 的 `ai-image-playground` Pages 项目；企业 API hostname 必须到达同一生产 runtime。域名绑定、DNS、Tunnel、CORS、登录策略及回调 allowlist 是仓库外状态，合并代码不会配置它们。本次清理不执行这些操作，也不据此宣称线上迁入或登录验收已完成。

**企业入口 connector（2026-11-14 起）。** `image-api.qiliangjia.one` 由独立 Compose 项目 `image-playground-enterprise-tunnel` 的 cloudflared 承载，不再属于任何环境项目（此前寄生在已退役的 `image-playground-internal` 项目里，#1849）。它沿用 Tunnel `b5b898d0-a7d0-48eb-a191-01648aeda4e1`（`qiliangjia.one` 所在账号，生产 muvloom 隧道在另一个账号，不能互换）；DNS、凭据不变。仓库外文件在 VPS `~/.config/ai-image-playground/enterprise-tunnel/`：`compose.yaml`（项目名固定，`restart: unless-stopped`，json-file 日志，只挂外部网络 `image-playground-paid_application`）与 `cloudflared/{config.yml,credentials.json}`（属主 65532，凭据 0400）。ingress 只有 `image-api.qiliangjia.one → http://image-playground-paid-release-router:37377` 和兜底 404。`image-admin.qiliangjia.one` 已随 internal 下线移除（DNS 记录保留到 internal 隧道清理）。启停与重建：`cd ~/.config/ai-image-playground/enterprise-tunnel && docker compose up -d`；不要用 `docker kill` 测试自动恢复，手动 kill 后容器不会被重启。改动前先备份 `config.yml`，改完核对 `https://image-api.qiliangjia.one/health` 的版本。

维护企业 API 路由时，connector 必须接入 `${PAID_PROJECT}_application`，上游使用现存 `image-playground-paid-release-router:37377`（自定义项目名时使用其实际 router 容器名），不能仅凭通用 `release-router` 别名猜测路由目标。额外 Docker 网络连接在 restart 后保留，但不会自动带到 recreate 后的新 connector；每次重建都须在承接流量前恢复网络连接并核验连通性。保留 connector 承载的其他获准 hostname 路由，不因本次代码清理修改生产资源。

维护者验收时记录企业与 muvloom 的 `version.json` 一致、`runtime-config.json` 含 `https://image-playground.qiliangjia.one → https://image-api.qiliangjia.one`，并用 GET 检查企业首页、登录入口和业务深链的 `X-Robots-Tag: noindex, nofollow`，muvloom 不受该头影响。共享 `robots.txt` 无法按 host 区分；noindex 是搜索指令，不是访问控制。浏览器确认企业只显示飞书入口，并用获准测试账号实测登录、回调与带 cookie 的 API 请求；muvloom 仍显示邮箱和 Google。发布冒烟不替代这些业务验收。

历史记录：此前 qlj Pages 发布曾报 `Authentication error [code: 10000]`。该事故名称保留用于检索；旧项目、旧令牌及双矩阵代码不再是当前发布或回滚路径。回滚共享前端或后端仍按本文相应流程执行。

### muvloom 站默认域名跳转

muvloom Cloudflare 账号的 Bulk Redirect List `muvloom_pages_canonical` 将
`ai-image-playground.pages.dev/` 以 301 跳转到 `https://muvloom.online/`，由账号级
`http_request_redirect` ruleset 的同名规则启用。开启 `subpath_matching`、
`preserve_path_suffix`、`preserve_query_string`；`include_subdomains=false`，不影响部署预览子域名。

这是账号配置，不在 Pages 构建产物中；Pages 常规发布不会覆盖它。更换 muvloom Pages 项目或
`PAID_PUBLIC_ORIGIN` 时同步核对这条规则。不要给默认域名放宽 API CORS：正式域名承载现有登录会话。
维护已有 ruleset 时只更新该规则，不覆盖账号中的其他规则；回滚时只禁用同名规则。

验收根路径、`/guide/en/?from=redirect-check` 和项目深链接均保留原路径与参数，浏览器跳转后仍保留锚点，
正式站能读取能力接口并正常展示登录状态。Cloudflare 的 `_redirects` 不支持域名级匹配，
该配置采用官方 [Pages 默认域名跳转流程](https://developers.cloudflare.com/pages/how-to/redirect-to-custom-domain/)。

### 手动构建与发布

1. 准备独立、干净且依赖已按锁文件安装的检出，固定到同一已通过 main CI 的公开提交及 `private.lock` 对应的 `private/`。前端必须带 overlay。不要移动其他会话的 `private/` 或重写锁文件。
2. 在执行发布的机器准备仓库外 0600 配置，格式见 `deploy/pages.env.example`。填写 `PAID_PAGES_PROJECT`、`PAID_BFF_BASE_URL`、`PAID_PUBLIC_ORIGIN`、`PAID_CLOUDFLARE_ACCOUNT_ID`，以及企业域名的 `ENTERPRISE_PUBLIC_ORIGIN`、`ENTERPRISE_BFF_BASE_URL`；令牌通过 `PAID_CLOUDFLARE_TOKEN_FILE` 引用受保护文件，未配置时使用该机器的 Wrangler OAuth。
3. 保留 muvloom 旧域名映射：`PAID_BFF_BASE_URLS_BY_ORIGIN='{"https://image.nainma.online":"https://api.nainma.online"}'`，避免旧域名会话失效。保留现有 `*_EXTRA_ASSETS_DIR` 等配置；该目录内容会公开发布。
4. 将下列路径替换为本次独立检出和已核验配置，再执行：

```sh

# 若选择远端发布，先 ssh macmini2；本机发布直接执行以下命令。
export PATH=/opt/homebrew/bin:$PATH
export PAGES_ENV_FILE=/absolute/protected/pages.env
cd /absolute/muvloom-checkout
./scripts/pages-release.sh muvloom
```

`pages-release.sh` 自动构建、向生产分支 `main` 上传，并等待自定义域名 `version.json` 与产物一致（最长 300 秒）。不直接调用省略分支的 `pages-deploy.sh`，否则会发布到预览环境。

macmini2 现有生产配置参考：`/Users/mac/services/aip-free-recovery-20260918/pages-primary-remote.env`；使用前须按「仓库外更新前提」迁移企业键名并核验令牌。`pages-remote.env` 指向旧备用 API，不能用于正常生产发布。服务容器停机不影响读取这些配置，但发布不得依赖失效令牌。本机使用本机受保护配置与凭据路径，不直接引用 macmini2 的绝对路径。

验收三个网页域名的 `version.json`、`runtime-config.json`：三者为同一部署、含预期私有提交，各自第一方 API 映射正确，企业域名带 noindex 头；再检查真实浏览器登录、原画布和前端改动。上传成功但域名校验超时时先查部署状态及缓存，不立即重复上传。默认静默更新；需要更新提示时设置对应 `*_NOTIFY_UPDATE=true`。

前端回滚：在独立检出恢复上一已验证公开/私有提交，使用相同生产配置重跑对应 `pages-release.sh`，按上述步骤验收。

## 后台：前端在 Pages、API 在 VPS

后台前端是 `apps/admin` 的 Vite 产物，跟 muvloom 站同一个 Cloudflare 账号、同一份 `private/` overlay，发到独立项目 `muvloom-admin`；
后台服务端还是 compose 里的 `admin` 容器，只出 API，经 tunnel 暴露成 `admin-api.muvloom.online`。
两个域名同站（eTLD+1 相同），所以 `SameSite=Lax` 的 `admin_session` cookie 在 `fetch(credentials:'include')` 和 `<img>` 上都带得过去；`*.pages.dev` 预览域登不上，与主站一致。

日常发布不用管它：`deploy.yml` 的 `admin-pages` job 在 muvloom 站（`pages-muvloom`）之后自动跑 `pages-release.sh admin`。应急手动发布：

```sh
export PAGES_ENV_FILE=/absolute/protected/pages.env
cd /absolute/muvloom-checkout   # 必须带已验证的 private/
./scripts/pages-release.sh admin
```

一次性切换（已执行过就不用再来）按顺序：

1. `cloudflared tunnel route dns image-playground-paid admin-api.muvloom.online`，ingress 加 `admin-api.muvloom.online → http://admin:37378`，重启 cloudflared。
2. `app.env` 加 `ADMIN_FRONTEND_ORIGIN=https://admin.muvloom.online`、`ADMIN_CORS_ALLOWED_ORIGINS=https://admin.muvloom.online`，把 `ADMIN_PUBLIC_ORIGIN` 改成 `https://admin-api.muvloom.online`（它是 API 自己的 origin，Google 控制台的回调地址跟着改成 `https://admin-api.muvloom.online/api/auth/google/callback`），删掉 `ADMIN_DIST_DIR` 那一行。
3. `app-compose.sh compose image-playground-paid up --detach --no-deps admin`，验 `https://admin-api.muvloom.online/health` 的 `version`。
4. 用 muvloom 账号凭证给公开素材桶应用浏览器直传 CORS：`npx wrangler r2 bucket cors set "$PUBLIC_ASSET_BUCKET" --file deploy/r2-public-assets-cors.json`，再用 `npx wrangler r2 bucket cors list "$PUBLIC_ASSET_BUCKET"` 确认 Admin 可 `GET` / `HEAD` / `PUT`，主站、企业域名与测试站只可 `GET` / `HEAD`。主站套用图生图灵感时会从浏览器读取原图，因此读权限必须覆盖主站 origin。
5. 建 Pages 项目并首发，再把 `admin.muvloom.online` 的 DNS 从 tunnel 切到 Pages，删掉 ingress 里旧的 `admin.muvloom.online` 那行。Cloudflare Access 两个域名都要覆盖。
6. 浏览器验收：登录、任务详情里的图片（跨域带 cookie）、私有计费面板、灵感库封面上传。

回滚：DNS 切回 tunnel、恢复 ingress 那一行，并从 `app.env` **删除** `ADMIN_DIST_DIR`（不能留空）；镜像内默认值 `/app/apps/admin/dist` 才会恢复自托管前端。

灵感库首次上线还要跑一次导入（幂等，重跑只补新条目）：

```sh
DATABASE_URL=<迁移账号> bun run apps/bff/scripts/import-inspirations.ts
```

它把 `apps/web/public/inspiration-manifest.json` 的 563 条导成已发布条目（22 个分类），封面先沿用原外链。
后台上传封面要 `PUBLIC_ASSET_BUCKET` / `PUBLIC_ASSET_BASE_URL`（见 `deploy/app.muvloom.env.example`），并先应用 `deploy/r2-public-assets-cors.json`；两个变量都空时后台只能引用外链，已发布内容不受影响。

## 测试环境（test 分支）

push 到 `test` 分支由 [`.github/workflows/deploy-test.yml`](../../.github/workflows/deploy-test.yml) 先发布隔离测试后端，再发布 https://test.muvloom.online；流程、数据范围与首次配置见[测试环境手册](test-environment.md)。

## 后端：镜像构建与发布（手动应急）

镜像经私有 GHCR `ghcr.io/muluk-m/ai-image-playground`（owner 必须小写）传输，VPS 按 digest 拉取，只传变更层。发布目录只含 `images.tsv` 与 `SHA256SUMS`，体积很小，可经工作站中转。

1. 构建机：GitHub Actions `ubuntu-24.04`（workflow 写死这个标签；`GITHUB_ACTIONS=true`）或 macmini2 手动兜底；其他 Linux 拒绝构建。独立检出已通过 PR/main CI 的公开提交与已验证的 `private/` Git 提交。生产使用 `paid`，隔离测试使用 `test`，两者均带 overlay。不得占用其他会话目录。
2. 构建到尚不存在的目录：

```sh
export PATH=/opt/homebrew/bin:$PATH   # 仅 macmini2
./scripts/build-vps-release.sh paid /Users/mac/releases/aip-<release-id>
```

构建输入固定为 Git 提交，不含未提交文件或凭据。使用 `aip-release` builder（4 核、6 GiB、无额外 Swap、阶段并发 1）生成 `linux/amd64` 镜像；保留现有构建锁，并与其他重型任务错峰。发布目录只包含 `images.tsv`、`SHA256SUMS`，archive transport 另含 `images.tar.gz`；部署代码使用 VPS 固定 runtime。生产构建 `paid-<公开12位>-<私有12位>`（muvloom 镜像）、`backup-<公开12位>` 与 `segmenter-<版本>-<公开12位>`；测试构建 `test-<公开12位>-<私有12位>` 与 backup，不携带 segmenter。每个镜像构建后立即推送，本地标签不变。首次推送上传全部层，之后只传变更层。

3. 工作站中转发布数据包，或由 CI 通过受限 SSH 入口上传；不要再从历史发布目录执行 `scripts/vps-deploy.sh`。手工发布必须使用固定 runtime：

```sh
scp -r macmini2:/Users/mac/releases/aip-<release-id> /tmp/
scp -r /tmp/aip-<release-id> tx-vps:/home/ubuntu/releases/
ssh tx-vps '/home/ubuntu/deploy-runtime/scripts/vps-deploy.sh paid /home/ubuntu/releases/aip-<release-id>'
```

接收脚本持有发布锁，校验 `SHA256SUMS`（须覆盖目录内全部数据文件，多出脚本或目录即拒绝），按 digest `docker pull` 并打回本地标签，再校验本地镜像确实带着该 digest、架构、`APP_VERSION` 和原生依赖，最后执行固定 runtime 的兼容迁移与启动；保留 VPS 原有运行配置。任一镜像拉取或校验失败都不改动服务。CI 部署失败时，入口把该发布目录改名为 `<id>.failed-run-<run_id>` 留作排查，同一提交可直接重跑。

### `images.tsv`

每行一个镜像，制表符分隔：`形态 本地标签 镜像ID 公开提交 私有提交 仓库digest`。形态为 `paid`（生产）/`test`（隔离测试）/`backup`/`segmenter`（仅生产发布携带）；私有提交无则为 `-`；第 6 列形如 `ghcr.io/muluk-m/ai-image-playground@sha256:<64位>`，archive 发布为 `-`。只有 5 列的旧发布包仍可接收，但 edition 必须属于当前发布目标。

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
- 验收 muvloom 与企业 API 别名、版本、当前与保留容器、备份、登录和业务数据。每个环境允许保留一代在途实例。涉及执行器切换时，验证新任务进入新实例，旧任务跨等待期限仍继续，刷新可续接，上游调用和结算不重复。
- 两代执行器的池上限之外，还要核算日志、admin、测试、备份与迁移连接。仅发布后端不重发 Pages，不更新共享源码目录。

### 旧协议实例与 `legacy-origin`

没有 drain 接口的旧 Compose BFF 或 worker 不能证明安全退休。旧 queue 数据库 gate 也不能证明免费 Agent 对话空闲。发现这些实例时，发布保留容器与 `legacy-origin`，在迁移或创建第三代之前失败。`DEPLOY_RETIRE_LEGACY=1` 不再绕过安全证明。

不得用近期无日志、空付费任务表或延长 SIGTERM 宽限代替排空证明。旧协议实例需要独立的运行证据与退休方案；普通发布不负责强制清除它。

## 合并分支后的迁移历史

数据库迁移仍拒绝「时间戳早于最新已应用记录、但没有应用记录」的 journal 项，不能为发布通行而补写伪造的应用记录。仅 `packages/db/src/migrate.ts` 内经过审计、固定两端 SQL SHA-256 和原始时间戳的替代关系可例外：

- `0079_task_metering` → `0085_task_metering_forward`：两者添加相同的 nullable `tasks.metering jsonb`；后者增加 `IF NOT EXISTS`，保留测试库已写入的计费决策。
- `0081_cli_device_oauth` → `0083_cli_device_oauth`：执行语句完全相同，后者仅增加说明注释；CLI 表、索引与已有授权记录不重建。

替代项必须在当前 journal 中，且已用匹配 SHA-256 应用，或时间戳严格晚于数据库最新迁移、将在本次 Drizzle 事务中执行。SQL 内容或时间戳不匹配、替代项本身被跳过、其他历史缺口都阻止发布。所有待执行 SQL 与对应历史记录由同一事务提交，失败不补写原条目的历史记录；已应用的名称、时间戳、哈希均不改写。

纯 main（到 `0084`，没有 `0079`/`0081`）升级只新增 `0085` 的应用记录；其历史行数自然比全新安装少两行。已执行原条目的测试库保留这些记录，再执行幂等的向前迁移。重跑通过同一替代关系确认安全，不要求两种历史的行数相等。

迁移记录与哈希不是线上 schema 的完整证明；手工改表、伪造历史、已有同名但不同类型的列仍需人工核对。尤其 `IF NOT EXISTS` 不修复错误列类型。发布只向前迁移，不执行历史 down 文件；不得为回滚版本删除 metering 或 CLI 授权数据。增加新的替代关系必须逐句证明等价并更新回归测试，不能增加通用忽略开关。

## 回滚与失败处理

使用包含本次安全修复的发布目录执行回滚，并指定已验证的旧镜像：

```sh
scripts/app-compose.sh rollback <project> <旧镜像>
```

回滚与发布使用同一容量和退休规则。保留旧代仍忙时，回滚可能被阻塞。禁止执行 `compose up --force-recreate` 或 `compose down` 绕过检查，也不要调用历史发布目录里的旧强停脚本。数据库不自动回滚；迁移须兼容新旧版本。

切换前失败时，脚本恢复旧 worker 接单与 activation marker，并通过同一退役检查清理本次候选。新 BFF 可能已经拾取 inbox，新 worker 可能已经开始任务；忙碌候选继续运行并占用保留槽位。切换后即使 `current` 尚未写入，也保护 route 指向的新一代。配套服务失败时，重跑同镜像完成剩余步骤，不再创建一代。

不手工修改 `current`、`route.json`、`activated/` 或 `legacy-origin`。route 缺失或损坏且仍有受管容器时，脚本保留实例并报告错误，不能回退到首次安装。部署锁记录进程身份，后续重跑可以回收已退出进程留下的锁；无法确定持有者的旧锁继续阻塞。

**部署锁与撞锁**：测试和生产共用 VPS 上的主机锁 `deploy.lock`，`vps-deploy.sh` 与 `rollout-runtime.sh` 都要先拿到它（构建机另有独立的镜像构建锁）。`app-compose.sh up|rollback` 手工入口在动任何容器之前（包括 log-collector 和首次安装）就要拿主机锁，随后启动的 `rollout-runtime.sh` 继承它；`rollout-runtime.sh` 单独手工运行时自己拿。继承靠环境变量 `DEPLOY_HOST_LOCK_PID` 与 `DEPLOY_HOST_LOCK_TOKEN`（锁 owner 文件里的进程标识），但它们只是声明：必须与 owner 文件的 pid 和 token 一致、持有进程仍活着且标识未变、并且该进程确实是当前进程的祖先，三者缺一就不继承，按正常流程抢锁（被占用则 75）。因此手工设置同一个 pid 或沿用旧 shell 里残留的变量都绕不过锁。锁被活着的进程持有时，主机侧不排队（排队的发布会在前一个结束后把生产带到另一个提交，例如撤销刚做完的手工回滚），立即以退出码 75 失败并打印持有者，什么都没改动：这是撞锁，不是版本故障。接收入口此时删除刚解开的发布目录。CI 侧由 [`scripts/ci-ship-release.sh`](../../scripts/ci-ship-release.sh) 发送发布：持有者是**另一环境的 CI 发布**（owner 的 `what=receive test …` 或 `what=receive paid …`）时，每 30 秒重试、最多等 15 分钟，因为它动的是另一套部署，等它结束再发不会把本环境带到意外的提交；持有者是手工 `app-compose`、单独的 `rollout-runtime` 或同环境发布，或还没写完 owner 时，立即以 75 失败，工作流报「VPS deploy lock is held by a rollout that is not the … CI deploy」，等持有者结束后按失败 job 重跑。等满 15 分钟仍被占用同样以 75 失败。撞锁以外的失败仍按原流程保留 `.failed-run-<run_id>`。直接 `compose`、`docker` 命令不受锁保护，不属于支持的发布或回滚路径。

运行中镜像不得删除。回滚优先使用 VPS 本地保留的镜像。本地镜像缺失时，由当前安全发布工具按已验证 digest 重新拉取，再执行回滚。GHCR 镜像清理不属于本流程。

固定 runtime 位于 `~/deploy-runtime`，更新时先保留带时间戳的备份目录。手工入口须明确传 `paid` 或 `test` 及数据发布目录，不执行 VPS 旧检出或历史发布包内的脚本。备份、恢复及历史备用记录见[灾备手册](cold-recovery.md)。
