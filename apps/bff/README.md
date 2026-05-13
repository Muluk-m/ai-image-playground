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
vim .env    # 填入实际 sub2api 端口与 key

# 4. 起 BFF
pnpm start

# 5. cf tunnel 把 :37377 暴露成公网域名（Cloudflare Zero Trust）
#    或者用 launchd / pm2 / brew services 做自启动
```

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

**当前不鉴权**。BFF 公网域名拿到的任何请求都会执行（消耗 sub2api 配额）。

加强方式（按推荐度排）：

1. **cf tunnel + Cloudflare Access policy**：在边缘做 IP/邮箱白名单或 OAuth，BFF 0 改
2. **API key middleware**：BFF 加 env `BFF_API_KEY`，请求必带 `Authorization: Bearer ...`；前端把它当成 BYOK profile 的 apiKey 填
3. **基于域名的 sub2api 错位**：让 sub2api 不开公网，仅本机 BFF 可访问（已经是默认状态）
