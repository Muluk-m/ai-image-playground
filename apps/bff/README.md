# @image-playground/bff

任务队列 BFF：Elysia + Bun + Drizzle + SQLite，部署在 mac mini 上为 image-playground 提供绕开 CF Edge 100s 超时的异步图像生成入口。

## 架构

```
浏览器 ──①CF Edge── (cf tunnel) ──> mac mini BFF
                              < 1s 快请求           │
                              不触发 100s            ▼ 立即返回 task_id

           mac mini BFF (此项目):
           ┌─────────────────────────────────────┐
           │ Elysia listening on :37377          │
           │   /v1/queue/{provider}/{model}/submit  → 入队             │
           │   /v1/queue/requests/{id}/status       → 查询             │
           │   /v1/queue/requests/{id}              → 拿结果           │
           │   /v1/queue/requests/{id}/cancel       → 取消             │
           │                                         │
           │   后台 worker fetch http://localhost/v1/...               │
           │     ↓ localhost = 不过 HTTP 网络层 = 不受 100s 限制       │
           │   sub2api → OpenAI / Gemini                              │
           └─────────────────────────────────────┘
```

## 端点

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/health` | liveness |
| `POST` | `/v1/queue/{provider}/{model}/submit` | 入队，立即返回 `request_id` |
| `GET` | `/v1/queue/requests/{id}/status` | 状态查询（含 queue_position / started_at 等）|
| `GET` | `/v1/queue/requests/{id}` | 拿结果（`completed` 时含 `payload`；其它状态 425）|
| `PUT` | `/v1/queue/requests/{id}/cancel` | 取消（in_progress 仅标记，worker 完成时会覆盖）|

请求/响应 schema 见 [`packages/shared/src/queue-protocol.ts`](../../packages/shared/src/queue-protocol.ts)。

## provider 路由

`{provider}` 决定 BFF 向 sub2api 发什么协议：

- `openai-compat` → `POST ${SUB2API_BASE_URL}/v1/images/generations`，OpenAI Images API 标准 body
- `gemini` → `POST ${SUB2API_BASE_URL}/v1beta/models/{model}:generateContent`，Google 原生 generateContent body

## 环境变量

复制 `.env.example` 到 `.env`，填入实际值：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `37377` | BFF 监听端口 |
| `SUB2API_BASE_URL` | `http://localhost:8080` | sub2api 本机地址，不含 `/v1` |
| `SUB2API_API_KEY` | (空) | sub2api 的 key（OpenAI 用 Bearer / Gemini 用 x-api-key） |
| `DATABASE_URL` | `../../artifacts/image-playground.sqlite` | SQLite 文件路径 |
| `CORS_ALLOWED_ORIGINS` | `*` | CORS 允许的浏览器 origin，多个用逗号分隔 |

## 本地开发

```bash
# 在仓库根
pnpm install

# 跑 BFF（首次会自动 migrate）
cd apps/bff
cp .env.example .env
# 编辑 .env 填入实际 SUB2API_BASE_URL / SUB2API_API_KEY
pnpm dev
```

测试：

```bash
pnpm test            # bun test，单测 + 路由集成
pnpm typecheck       # tsc --noEmit
```

## 部署（mac mini）

```bash
# 1. 装 bun
curl -fsSL https://bun.sh/install | bash

# 2. clone + install
git clone <repo> ~/image-playground
cd ~/image-playground
pnpm install

# 3. 配置
cd apps/bff
cp .env.example .env
vim .env    # 填入实际 SUB2API_BASE_URL / SUB2API_API_KEY

# 4. 注册为 LaunchAgent 自启动（推荐）
./deploy/install.sh

# 4'. 或者前台跑（仅测试）
pnpm start

# 5. cf tunnel 把 :37377 暴露成公网域名（Cloudflare Zero Trust）
```

### LaunchAgent 管理

`deploy/install.sh` 把 `deploy/launchd.plist.tpl` 占位符替换后写到
`~/Library/LaunchAgents/qlj.image-playground.bff.plist`，并通过 `launchctl bootstrap`
注册到当前 GUI session。开机自动起、崩溃自动重启（10s 节流）、stdout/stderr
分别落到 `~/Library/Logs/qlj-bff.log` / `qlj-bff.err.log`。

| 操作 | 命令 |
|---|---|
| 安装 / 更新（覆盖旧的） | `./deploy/install.sh` |
| 一键 redeploy（git pull + web build + 重启 BFF） | `./deploy/redeploy.sh` |
| 卸载 | `./deploy/uninstall.sh` |
| 查看状态 | `launchctl print gui/$(id -u)/qlj.image-playground.bff \| head -20` |
| 重启 | `launchctl kickstart -k gui/$(id -u)/qlj.image-playground.bff` |
| 实时日志 | `tail -f ~/Library/Logs/qlj-bff.log` |
| 错误日志 | `tail -f ~/Library/Logs/qlj-bff.err.log` |
| 临时停 | `launchctl bootout gui/$(id -u)/qlj.image-playground.bff` |

> 修改 `.env` 后**必须** `kickstart` 才生效（plist 不变也要重新加载进程的 env）。
> 修改源码后用 `kickstart -k` 强制重启即可（不需要重跑 install.sh，因为 plist 内容没变）。
> 修改 plist 模板（端口、路径等结构性变化）后才需要重跑 `install.sh`（内部 bootout + bootstrap）。

### 一键 redeploy

`deploy/redeploy.sh` 把日常部署 5 步合一：

1. stash 本地未提交（如 `.env` / 部署侧 `.gitignore` tweak）
2. `git pull --rebase origin main`
3. 恢复 stash
4. `apps/web` rebuild dist（BFF 直接 serve 新前端）
5. `launchctl kickstart -k` 重启 BFF（加载新代码 + `.env`）

```bash
# 本地（在 mac mini 上）
./deploy/redeploy.sh

# 远程（从其它机器）
ssh macmini "bash /Users/qiqian/workspace/repos/qlj-image-playground/apps/bff/deploy/redeploy.sh"
```

新前端 build 含 SW build-version token（vite plugin 注入），客户端浏览器
拿到新 sw.js → install → activate → controllerchange → 自动 `location.reload()`，
**无需强刷**就拿到新版本。

### 前端接入

在 image-playground 前端构建时通过 `VITE_BFF_QUEUE_CHANNELS` 环境变量注入 BFF channels：

```bash
# apps/web/.env.local
VITE_BFF_QUEUE_CHANNELS='[
  {
    "id": "qlj-bff-openai",
    "kind": "openai-queue",
    "label": "qlj BFF · OpenAI",
    "bffBaseUrl": "https://bff.your-domain.com",
    "models": [{ "id": "gpt-image-2", "label": "GPT Image 2" }],
    "defaults": { "apiMode": "images", "timeout": 600 }
  },
  {
    "id": "qlj-bff-gemini",
    "kind": "gemini-queue",
    "label": "qlj BFF · Gemini",
    "bffBaseUrl": "https://bff.your-domain.com",
    "models": [{ "id": "gemini-3.1-flash-image", "label": "Gemini 3.1 Flash Image" }],
    "defaults": { "apiMode": "images", "timeout": 600 }
  }
]'
```

打包到 dist 后，主界面 InputBar 的模型下拉里就能看到这些 BFF channel。

## 任务状态机

```
queued → in_progress → completed
                     ↘ failed (upstream / network error)
                     ↘ cancelled (手动 cancel)
```

- `queued`: submit 刚写入数据库，worker 还没拿到
- `in_progress`: worker 已经 fetch sub2api，等待响应
- `completed`: 成功，`result_payload` 字段含上游原始响应
- `failed`: 上游 HTTP error / 网络故障，`error_message` + `error_type` 记录
- `cancelled`: 手动调 cancel；in_progress 任务的 worker **不会真正中断**（无 AbortController 路由），完成时会覆盖回 completed/failed。第二阶段优化

## 鉴权

**BFF 自身不做应用层鉴权**（不强制 API key）。实际安全靠以下组合形成防护链：

1. **CORS Origin 限制**（`CORS_ALLOWED_ORIGINS`）：默认只允许 `https://image-playground.qiliangjia.one` + `http://localhost:5173`，浏览器跨源 fetch 被 preflight 拦截
2. **上游站点的 Cloudflare Access**：image-playground 域名挂了 CF Access policy（IP/邮箱白名单或 OAuth），不能登录的人拿不到前端页面，**无从触发对 BFF 的浏览器侧调用**
3. **BFF URL 不公开**：cf tunnel 暴露的域名仅在前端 build env 里出现，不进源码仓库

> ⚠️ 这条链**不防** "拿到 BFF URL + curl 伪造 Origin" 的攻击者。如果需要硬防，可在 cf tunnel 上挂 Cloudflare Access policy（推荐，0 改 BFF）或 BFF 加 `Authorization: Bearer ...` middleware（前端改 BYOK profile apiKey 填）。
