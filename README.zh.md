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
  "$config_root/apps/image-playground-personal" \
  "$config_root/apps/image-playground-commercial"

cp deploy/infra.env.example "$config_root/infra.env"
cp deploy/app.personal.env.example \
  "$config_root/apps/image-playground-personal/app.env"
cp deploy/app.commercial.env.example \
  "$config_root/apps/image-playground-commercial/app.env"
cp deploy/migrate.env.example \
  "$config_root/apps/image-playground-personal/migrate.env"
cp deploy/migrate.env.example \
  "$config_root/apps/image-playground-commercial/migrate.env"
chmod 600 \
  "$config_root/infra.env" \
  "$config_root/apps/image-playground-personal/app.env" \
  "$config_root/apps/image-playground-personal/migrate.env" \
  "$config_root/apps/image-playground-commercial/app.env" \
  "$config_root/apps/image-playground-commercial/migrate.env"

# 启动前替换所有 replace-* 占位值。
```

每个部署使用三个 PostgreSQL 身份。`migrate.env` 保存一次性 schema owner；
`app.env` 保存只具备 DML 权限的应用写角色和 Admin SELECT-only 角色。两个部署还必须使用
不同数据库、bucket、对象存储凭证、服务间令牌、上游凭证与 CORS 来源。真实密钥与
operator 配置始终留在仓库外目录，仓库只提交安全样例。每个 `app.env` 旁可选放置
`operator-config.json`。文件缺失表示全部能力关闭；文件无效时 BFF 拒绝启动。

先启动基础设施，为每个部署分别创建 migrator、应用写角色和 Admin 只读角色，只构建一次
镜像，再分别启动两个 project：

```bash
# 只需创建一次；该 network 由宿主机现有反向代理持有，不属于任何应用 project。
docker network create image-playground-edge

scripts/infra-compose.sh up

# 先把 infra.env 中七个 POSTGRES_MIGRATOR_* / POSTGRES_APP_* /
# POSTGRES_ADMIN_* 值设为自用站配置并执行，再替换成经营站配置并再次执行。
scripts/infra-compose.sh provision

scripts/app-compose.sh build-private ai-image-playground:local
scripts/app-compose.sh up image-playground-personal
scripts/app-compose.sh up image-playground-commercial
```

`infra-compose.sh` 默认读取
`$XDG_CONFIG_HOME/ai-image-playground/infra.env`，可用 `INFRA_ENV_FILE` 覆盖。`up` 会等待
PostgreSQL 与 MinIO 健康，创建 `MINIO_BUCKET_NAMES` 中的 bucket、关闭匿名访问，并配置
45 天过期规则。`provision` 会幂等创建部署数据库、schema-owner migrator、DML-only
应用角色与 Admin 只读角色。基础设施端口默认只绑定 `127.0.0.1`；应用 Compose 不发布
PostgreSQL 或 MinIO 端口。

`app-compose.sh` 默认读取
`$XDG_CONFIG_HOME/ai-image-playground/apps/<project>/app.env`，并要求同目录存在
`migrate.env`。只有一次性 migration 服务能读取 schema-owner 凭据。它先完成依赖检查，
执行公开与已存在的私有 Drizzle migration，再启动 BFF、worker 与 Admin；确认 BFF
健康后才激活 nginx。以后后端重启时 nginx 容器继续可用。每个 Web 容器根据自己的外部
配置写入 `/usr/share/nginx/html/runtime-config.json`，因此两个域名共用同一份 Web
构建产物，但运行时配置互不相同。

宿主机反向代理必须以容器运行并加入 `image-playground-edge`。域名应转发到以下稳定
network alias：

| 目标 | 上游 |
|---|---|
| 自用 Web | `http://image-playground-personal-web:8080` |
| 经营 Web | `http://image-playground-commercial-web:8080` |
| 自用 Admin | `http://image-playground-personal-admin:37378` |
| 经营 Admin | `http://image-playground-commercial-admin:37378` |

Admin 前必须再加 Cloudflare Access、VPN 或 IP 白名单。仓库中的 Compose 不发布宿主机
端口，入口统一归域名代理管理。如果现有宿主机代理不是容器，operator 需要提供额外的
Compose override，只把 Web/Admin 端口绑定到回环地址。

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
scripts/app-compose.sh status image-playground-personal
scripts/app-compose.sh stop image-playground-personal
scripts/app-compose.sh stop image-playground-commercial
scripts/infra-compose.sh down
```

停止应用 project 不会删除 PostgreSQL 或 MinIO 数据，也不会删除外部基础设施或入口
network。只有两个应用 project 都已停止后，才停止基础设施。

`app-compose.sh rollback` 只在符合当前分角色 Compose 契约的镜像之间切换，并保持先后端、
后静态页面的激活顺序：

```bash
scripts/app-compose.sh rollback image-playground-personal ai-image-playground:previous
scripts/app-compose.sh rollback image-playground-commercial ai-image-playground:previous
```

如果兼容的旧 tag 未保留，先从对应代码检出重新构建。首次从 SQLite 切换到 PostgreSQL
不使用这个 helper；应从旧代码检出与旧配置恢复原部署，并挂回只读 SQLite 备份。

### Fleet 部署契约

`.fleet/deploy.json` 现在声明三个 Compose 服务：已提交的基础设施 project 和两个独立
应用 project。Fleet 只构建一次 `ai-image-playground:local`，等待 Compose 健康检查，
并通过 service dependency 保证先部署基础设施。

当前 fleet Compose schema 没有逐服务 `--env-file` 字段，因此 macmini 上的 fleet agent
必须导出：

```text
COMPOSE_ENV_FILES=/Users/qiqian/.config/ai-image-playground/infra.env
```

应用容器会直接加载以下 project 专用文件：

```text
/Users/qiqian/.config/ai-image-playground/apps/image-playground-personal/app.env
/Users/qiqian/.config/ai-image-playground/apps/image-playground-commercial/app.env
```

以下宿主机事实仍需 operator 人工确认，本次改动不会自动处理：

- fleet 使用的部署账号 home 是 `/Users/qiqian`。
- 已评审的私有 overlay 仓库检出在 Fleet 工作副本的 `./private`；该检出缺失时
  `.fleet/deploy.json` 会按设计让私有构建失败。
- `image-playground-edge` 已存在，域名代理也已加入。
- 基础设施与应用配置中的 `INFRA_NETWORK_NAME` 完全一致。
- MinIO 已为两个私有 bucket 分别创建应用凭证。bootstrap profile 只创建 bucket 和
  生命周期规则，不创建限定作用域的 MinIO 用户。
- PostgreSQL 已为每个部署分别创建数据库写角色与 Admin 只读角色；
  `scripts/infra-compose.sh provision` 只创建角色，不迁移旧数据。
- 启动已提交的基础设施 project 前，已核实现有 macmini PostgreSQL 与 MinIO 数据归属。

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
