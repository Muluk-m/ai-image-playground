<div align="center">

<img src="./apps/web/public/pwa-icon.svg" alt="" width="96" height="96" />

# AI Image Playground

浏览器里的 AI 生图工作台，自带无限画布创作模式 — 填个 API key 即可用，历史与配置全部本地存储。

[![License](https://img.shields.io/badge/License-MIT-10b981?style=flat-square)](./LICENSE)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.x-FBF0DF?style=flat-square&logo=bun&logoColor=black)](https://bun.sh/)

[English](./README.md) | 中文

[**在线试玩 · image.nainma.online**](https://image.nainma.online/)

</div>

<p align="center">
  <a href="https://image.nainma.online/" target="_blank">
    <img src="./docs/images/canvas-hero.jpg" alt="创作模式 — 在图上手绘标注、描述修改意图，直接在无限画布上迭代" width="900" />
  </a>
</p>

<p align="center"><i>创作模式：圈出想改的地方、写下要求，标注 → 生成 → 合并素材，全在一张画布上完成。</i></p>

## ✨ 能干嘛

两种工作方式，共享一份历史：

### 🎨 创作模式 — 无限画布

- **标注即迭代** — 选中图片，在上面画圈 / 箭头 / 写字，描述修改要求；模型按标注意图出一张干净新图，不带手绘痕迹
- **合并素材** — 框选多张图一起发起，作为参考图合并生成（「把小猫放到小狗旁边」）
- **原地生成** — 不选图时就是纯文生图，结果直接落在画布上、跟素材摆在一起
- **并发不阻塞** — 每次生成都有实时占位框，多个任务并行跑、你继续操作画布，n>1 一次出多张变体
- **刷新不丢** — 画布内容本地持久化；后端模式下进行中的生成刷新页面后自动续跑
- **与工作台打通** — 画布生成同样落入共享历史（可收藏 / 检索 / 复用），工作台的图也能一键发到画布继续创作
- **键盘友好** — 完整快捷键 + 内置速查面板（⌘⏎ 发起生成，V/H/D/E 切工具，撤销重做…）

### 🛠 工作台模式

- **多个模型** — OpenAI、Gemini、自定义 HTTP，自带 API key 即用
- **参考图 + 遮罩** — 最多 16 张参考图，OpenAI 路径支持可视化遮罩编辑器
- **瀑布流历史** — 每次生成连同实际参数本地保存，可收藏、可检索
- **灵感库** — 几百个一键套用的高质量提示词

### ⚙️ 哪都能跑

- **短任务直跑** — 浏览器直连上游，秒级出图
- **长任务也能跑** — 可选「后端模式」处理 30s–5min 的长任务（Gemini 3 Pro 等），任务持久化，刷新页面也不丢
- **不泄密** — 后端模式下 API key 只在服务器 env 里，浏览器永远拿不到
- **纯本地** — 历史、配置、API key 全存浏览器 IndexedDB

<p align="center">
  <a href="https://image.nainma.online/" target="_blank">
    <img src="./docs/images/preview.png" alt="工作台模式" width="900" />
  </a>
</p>

## 🚀 本地试一下

```bash
git clone https://github.com/Muluk-m/ai-image-playground.git
cd ai-image-playground
pnpm install
pnpm dev:web        # 起前端，打开 http://localhost:5173
```

在右上角设置里填一个 OpenAI 或 Gemini 的 API key（baseUrl 留默认）就能生图了。

## 📦 部署

### 选项 1 · 纯静态（最简单）

一键部署：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Muluk-m/ai-image-playground&project-name=ai-image-playground&repository-name=ai-image-playground)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/Muluk-m/ai-image-playground)

仓库已带上 `vercel.json` 和 `netlify.toml`，针对 monorepo 配好了构建命令和产物目录。点按钮跳过去登一下账号、确认下就能跑，零额外配置。

其它静态托管（Cloudflare Pages / GitHub Pages / nginx / S3）也都能用：

```bash
pnpm install && pnpm build
# 把 apps/web/dist/ 上传到你的静态托管
```

用户自己在页面里填 API key，浏览器直连模型上游。**不支持 1 分钟以上的长任务**（edge 平台超时）。

### 选项 2 · 容器化应用

应用只构建一个本地镜像。nginx、BFF、worker 与 Admin 都从该镜像启动，两个部署
project 共用 [`deploy/compose.app.yaml`](./deploy/compose.app.yaml)。nginx 提供 Web
静态文件，并把 `/api/*`、`/health` 和保持不变的 `/v1/*` API 路径代理到 BFF。此部署
形态下 BFF 不再提供 Web 静态文件。

先在仓库外准备基础设施和两个部署的配置：

```bash
config_root="${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground"
mkdir -p \
  "$config_root/apps/image-playground-internal" \
  "$config_root/apps/image-playground-paid"

cp deploy/infra.env.example "$config_root/infra.env"
cp deploy/app.internal.env.example \
  "$config_root/apps/image-playground-internal/app.env"
cp deploy/app.paid.env.example \
  "$config_root/apps/image-playground-paid/app.env"
cp deploy/migrate.env.example \
  "$config_root/apps/image-playground-internal/migrate.env"
cp deploy/migrate.env.example \
  "$config_root/apps/image-playground-paid/migrate.env"
chmod 600 \
  "$config_root/infra.env" \
  "$config_root/apps/image-playground-internal/app.env" \
  "$config_root/apps/image-playground-internal/migrate.env" \
  "$config_root/apps/image-playground-paid/app.env" \
  "$config_root/apps/image-playground-paid/migrate.env"

# 启动前替换所有 replace-* 占位值。
```

每个部署使用三个 PostgreSQL 身份。`migrate.env` 保存一次性 schema owner；
`app.env` 保存只具备 DML 权限的应用写角色和 Admin SELECT-only 角色。两个部署还必须使用
不同数据库、对象存储位置、对象存储凭证、服务间令牌、上游凭证与 CORS 来源。真实密钥与
operator 配置始终留在仓库外目录，仓库只提交安全样例。每个 `app.env` 旁可选放置
`operator-config.json`。文件缺失表示全部能力关闭；文件无效时 BFF 拒绝启动。

先启动基础设施，为每个部署分别创建 migrator、应用写角色和 Admin 只读角色，只构建一次
镜像，再分别启动两个 project：

```bash
scripts/infra-compose.sh up

# 先把 infra.env 中七个 POSTGRES_MIGRATOR_* / POSTGRES_APP_* /
# POSTGRES_ADMIN_* 值设为内部站配置并执行，再替换成收费站配置并再次执行。
scripts/infra-compose.sh provision

scripts/app-compose.sh build-private ai-image-playground:local
scripts/app-compose.sh up image-playground-internal
scripts/app-compose.sh up image-playground-paid
```

`infra-compose.sh` 默认读取
`$XDG_CONFIG_HOME/ai-image-playground/infra.env`，可用 `INFRA_ENV_FILE` 覆盖。`up` 只等
PostgreSQL 健康。`provision` 会幂等创建部署数据库、schema-owner migrator、DML-only
应用角色与 Admin 只读角色。没有任何 Compose 文件发布 PostgreSQL 端口，排查用
`docker compose exec`。

对象存储用任意 S3 兼容服务，两份部署样例都指向 Cloudflare R2。bucket 与其他业务共用时，
`S3_KEY_PREFIX` 把该部署的对象限制在一个前缀下。每个 project 另跑一个 `pg-backup`
sidecar，每天把本组数据库的 `pg_dump` 传到同 bucket 的 `pg/<UTC 日期>.dump`。保留期由
bucket 的 lifecycle 规则负责，sidecar 不删任何对象。

`app-compose.sh` 默认读取
`$XDG_CONFIG_HOME/ai-image-playground/apps/<project>/app.env`，并要求同目录存在
`migrate.env`。只有一次性 migration 服务能读取 schema-owner 凭据。它先完成依赖检查，
执行公开与已存在的私有 Drizzle migration，再启动 BFF、worker、Admin 与备份 sidecar；
确认 BFF 健康后才激活隧道。

下面的选项 4 用 Cloudflare Tunnel 接入域名，不起 nginx。若要改用现有反向代理，把该代理
容器加入每个 project 的 `application` network，并显式启动 `web` 服务，域名转发到以下稳定
network alias：

| 目标 | 上游 |
|---|---|
| 内部 Web | `http://image-playground-internal-web:8080` |
| 收费 Web | `http://image-playground-paid-web:8080` |
| 内部 Admin | `http://image-playground-internal-admin:37378` |
| 收费 Admin | `http://image-playground-paid-admin:37378` |

这种代理必须把 `X-Forwarded-For` 覆写成唯一的客户端地址，而不是追加调用方传来的链；
同时 BFF 要改用 `CLIENT_IP_SOURCE=x-forwarded-for`，而不是仓库里默认的
`cf-connecting-ip`。该值用于登录与注册限流，多值链会回退到直连代理地址。

Admin 前必须再加 Cloudflare Access、VPN 或 IP 白名单。仓库中的 Compose 不发布宿主机
端口。

从旧 SQLite 部署一次性切换时：

1. 停止应用。
2. 执行 `SQLITE_DATABASE_PATH=/absolute/image-playground.sqlite SQLITE_BACKUP_PATH=/absolute/image-playground.readonly.sqlite bun run scripts/prepare-postgres-cutover.ts`。命令会在仍有 `queued` 或 `in_progress` 任务时拒绝切换，写出一致的只读备份，并且不导入历史数据。
3. 按上文启动并 provision 全新的 PostgreSQL 数据库。
4. 启动应用 project。解除维护窗口前，执行 `DATABASE_URL=postgresql://<migrator>@127.0.0.1:5432/deployment_database pnpm db:verify`，再确认 `/health`、登录、服务端任务历史为空，并完成一次新生图。

验证失败时，停止新应用，使用只读 SQLite 备份恢复上一镜像与配置。生产环境不要执行
公开或私有 rollback SQL；`packages/db/drizzle/rollback/` 与
`private/apps/bff/billing/rollback/` 只用于丢弃全新的空部署。

查看状态或独立停止任一 project：

```bash
scripts/app-compose.sh status image-playground-internal
scripts/app-compose.sh stop image-playground-internal
scripts/app-compose.sh stop image-playground-paid
scripts/infra-compose.sh down
```

停止应用 project 既不会删除 PostgreSQL 卷，也不会删除外部基础设施 network。只有两个
应用 project 都已停止后，才停止基础设施。

`app-compose.sh rollback` 只在符合当前分角色 Compose 契约的镜像之间切换，并保持先后端、
后静态页面的激活顺序：

```bash
scripts/app-compose.sh rollback image-playground-internal ai-image-playground:previous
scripts/app-compose.sh rollback image-playground-paid ai-image-playground:previous
```

如果兼容的旧 tag 未保留，先从对应代码检出重新构建。首次从 SQLite 切换到 PostgreSQL
不使用这个 helper；应从旧代码检出与旧配置恢复原部署，并挂回只读 SQLite 备份。

### 选项 3 · 前后端分离（静态宿主 + API 子域）

前端作为纯静态产物托管在 Cloudflare Pages 一类的宿主上，后端仍用选项 2 的镜像跑
BFF / worker / Admin，只是不再由 nginx 托管前端。

公开版 BYOK 产物：

```bash
scripts/pages-deploy.sh public ai-image-playground preview-branch
```

私有版产物（工作副本必须存在已评审的 `./private` overlay）：

```bash
BFF_ENABLED=true BFF_BASE_URL=https://api.example.com \
  scripts/pages-deploy.sh private ai-image-playground-paid main
```

edition 只断言 overlay 在不在，后端开关与它无关：公开版产物可以设 `BFF_ENABLED=true`，
私有版产物也可以只走 BYOK。wrangler 从环境读 `CLOUDFLARE_ACCOUNT_ID` 与
`CLOUDFLARE_API_TOKEN`，同一份检出因此能发布到两个 Cloudflare 账号下的两个项目。

`build:static-host` 在普通构建之后写出 `dist/runtime-config.json`。配置不完整时构建
直接失败，不会部署出一个连不上后端的站点。缓存策略与 SPA 回退由随产物一起发布的
[`apps/web/public/_headers`](./apps/web/public/_headers) 与
[`apps/web/public/_redirects`](./apps/web/public/_redirects) 提供，对齐
[`deploy/nginx.conf`](./deploy/nginx.conf) 的同名规则。

不用隧道时，在后端 `app.env` 设 `APP_INGRESS_MODE=api-only` 并启动 `web` 服务：同一个
nginx 容器只反代 API，所有非 API 路径直接返回 404，不再带出第二份前端。选项 4 用
cloudflared 取代这个容器。后端侧还必须满足：

- `CORS_ALLOWED_ORIGINS` 精确写出前端 origin。凭据请求下不能用 `*`。
- 前端域与 API 域**同一注册域**（如 `app.example.com` 与 `api.example.com`）。会话
  cookie 是 `Secure; SameSite=Lax`，跨注册域不会被发送。用宿主分配的默认域名
  （`*.pages.dev` 等）就必须改 cookie 策略。
- 提交路由的请求体上限。输入图与遮罩以 base64 内联在 submit 的 JSON 里，客户端上限
  512 MiB、BFF 与 nginx 上限 600 MB。如果 API 域经过带请求体上限的代理（Cloudflare
  橙云在 Free / Pro 是 100 MB），大图多图的提交会在边缘被拒。

收费形态额外需要私有 overlay：静态宿主的 Git 构建拿不到私有仓库，用本地或 CI 构建后
上传产物。

### 选项 4 · 单台 VPS + Cloudflare Tunnel + Pages

仓库里的 Compose 文件就是按这个形态写的。一台机器跑 PostgreSQL 和每个部署一个应用
project，每个 project 自带一个 cloudflared，因此宿主机不发布任何端口，也不需要放通入站。
前端是每个部署一个 Cloudflare Pages 项目，对象存储是 R2。

```text
Pages  image-playground.example.com ─┐
                                     ├─ Cloudflare ─ tunnel ─ VPS ─ bff ─ postgres
API    image-api.example.com ────────┘                             ├─ worker ─ R2
Admin  image-admin.example.com ──────────────────────────────────  └─ admin
```

仓库外配置照选项 2 准备，再加隧道文件。每个部署在自己的 Cloudflare 账号下建一个隧道，
凭据放到 `app.env` 旁边：

```bash
config_root="${XDG_CONFIG_HOME:-$HOME/.config}/ai-image-playground"
app_dir="$config_root/apps/image-playground-internal"
mkdir -p "$app_dir/cloudflared"

cloudflared tunnel create image-playground-internal
cp ~/.cloudflared/<tunnel-uuid>.json "$app_dir/cloudflared/credentials.json"
cp deploy/cloudflared/config.yml.example "$app_dir/cloudflared/config.yml"
# 替换该文件里的隧道 UUID 与两个 hostname。
chmod 600 "$app_dir/cloudflared/credentials.json"
```

把 `deploy/operator-config.internal.example.json` 复制成 `$app_dir/operator-config.json`
并按需调整，然后拉起：

```bash
scripts/infra-compose.sh up
scripts/infra-compose.sh provision                    # 每个部署数据库跑一次
scripts/app-compose.sh build ai-image-playground:local
scripts/app-compose.sh up image-playground-internal
```

在持有域名的那个账号下把 hostname 指到隧道：

```bash
cloudflared tunnel route dns image-playground-internal image-api.example.com
cloudflared tunnel route dns image-playground-internal image-admin.example.com
```

给 bucket 配两条 lifecycle 规则。仓库里没有任何代码会创建它们；不带前缀的规则会误删
其他业务的对象：

```bash
wrangler r2 bucket lifecycle list <bucket>
wrangler r2 bucket lifecycle add <bucket> --name pixels \
  --prefix image-playground/ --expire-days 45
wrangler r2 bucket lifecycle add <bucket> --name pg-dumps \
  --prefix pg/ --expire-days 14
```

先发布前端，确认可用后再把它的 DNS 记录切到 Pages：

```bash
BFF_ENABLED=true BFF_BASE_URL=https://image-api.example.com \
  scripts/pages-deploy.sh public <pages-project> main
```

前端域与 API 域同选项 3 一样必须是同一注册域：Admin 会话 cookie 是
`Secure; SameSite=Lax`。

把每一步换成 `image-playground-paid` 再做一遍，就能在同一台机器上跑第二套完全独立的
部署：各自的数据库、R2 位置、隧道、Pages 项目与 Cloudflare 账号，只共用 PostgreSQL
进程和这台机器。

## 🛠 开发

```bash
pnpm install
pnpm dev          # web + bff 同时起
pnpm test         # vitest + bun:test
pnpm typecheck
pnpm lint
```

技术栈：前端 React 19 + Vite · 画布 tldraw · 后端 Bun + Elysia + PostgreSQL · monorepo pnpm + Turbo。

## 🙏 致谢

Fork 自 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground)（MIT），保留原项目核心 UX（参考图 + 遮罩、瀑布流历史、灵感库、模型快选、实际参数对比）。本 fork 扩展了 Gemini 原生协议、长任务队列模式、可选后端，以及无限画布创作模式。

灵感库提示词数据：
- [freestylefly/awesome-gpt-image-2](https://github.com/freestylefly/awesome-gpt-image-2)（MIT）
- [YouMind-OpenLab/awesome-nano-banana-pro-prompts](https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts)（CC BY 4.0）

## 📄 License

[MIT](./LICENSE)
