# @image-playground/bff

任务队列 BFF：Elysia + Bun + Drizzle + SQLite。为 `apps/web` 提供异步图像生成入口，绕开浏览器 / Edge / CF Pages 之类平台的 100s idle timeout，让 Gemini 3 Pro Image 这类 30s-15min 长任务可以稳定跑完。

## 架构

```
              < 1s 短请求                   localhost
浏览器 ─submit─▶ ┌──────────────┐ ─fetch─▶ ┌─────────┐ ─▶ OpenAI / Gemini
浏览器 ─poll  ─▶ │  BFF :37377  │          │ upstream│     (OpenAI / Gemini API 或自建代理)
浏览器 ─result─▶ └──────────────┘          └─────────┘
                  fire-and-forget
                  worker 不受 HTTP
                  跳数 / Edge 超时
                  限制
```

BFF 同时托管 `apps/web/dist` 静态产物（`STATIC_DIR` 指向 dist 即可），跟 BFF 同源省 CORS preflight；想分开部署也行，前端 `runtime-config.json.bff.baseUrl` 填跨域 origin 即可。

## 设计取舍

- **原生 `fetch`，不接 OpenAI / Gemini 官方 SDK**。BFF 是「协议透传层」— 上游可能是 OpenAI / Vertex 官方，也可能是自建代理（会包错误 envelope、改路径前缀）。SDK 内置的 base URL / retry / 错误判定 / 流式协议都跟代理不兼容。手写 `buildOpenAIBody` / `buildGeminiBody` 让透传字段不失真。
- **校验用 TypeBox（`t.Object` / `t.String`），不用 Zod**。TypeBox 是 Elysia 的原生 schema，路由层自动接管 params / query / body 校验、错误响应、类型推断、OpenAPI 生成。换 Zod 要每个路由手动 `parse` 再组装错误响应。Bun 上 TypeBox 产物更小、运行更快。
- **task-runner 是 fire-and-forget 不是 worker pool**。`submit` 端点 `spawnTask(id)` 起一个 Promise 就返回；并发由 Bun runtime 调度，调上游是 localhost HTTP 没有真正阻塞 worker。worker pool 是过早抽象。
- **状态机所有写入都带 WHERE predicate**（atomic claim + 终态守护）。`queued → in_progress` 要求当前 status 仍是 `queued`，防止 startup recovery 与遗留 runTask 并发双写；写 `completed` / `failed` 要求 status 仍是 `in_progress`，防止已被 cancel 的任务被 worker 反悔覆盖。
- **不做应用层 auth**。运维场景下安全靠 CORS Origin 白名单 + 反向代理上的 access policy + BFF URL 不公开 的多层防护（见下文「鉴权」节）。

## 端点

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/health` | liveness |
| `GET` | `/api/channels` | 公开发现接口，返回 sanitized channel 列表（前端 boot 时拉） |
| `POST` | `/v1/queue/{provider}/{model}/submit` | 入队，立即返回 `request_id` |
| `GET` | `/v1/queue/requests/{id}/status` | 状态查询（含 queue_position / started_at 等）|
| `GET` | `/v1/queue/requests/{id}` | 拿结果（`completed` 时含 `payload`；其它状态 425）|
| `PUT` | `/v1/queue/requests/{id}/cancel` | 取消（in_progress 仅标记，worker 完成时会覆盖）|

请求 / 响应 schema 见 [`packages/shared/src/queue-protocol.ts`](../../packages/shared/src/queue-protocol.ts) 和 [`packages/shared/src/channel-discovery.ts`](../../packages/shared/src/channel-discovery.ts)。

## provider 路由

`{provider}` URL 段决定 BFF 向上游发什么协议：

- `openai-compat` → `POST ${channel.baseUrl}/images/generations`（或 `/images/edits` 当带参考图 / mask），OpenAI Images API 标准 body
- `gemini` → `POST ${channel.baseUrl}/models/{model}:generateContent`，Google 原生 generateContent body

channel kind `openai-queue` / `gemini-queue` 在前端层用，到 BFF URL 就转成 `openai-compat` / `gemini`（参见 `apps/web/src/lib/channels/queueClient.ts` 的 `toQueueProvider`）。

## Channel 配置（`apps/bff/channels.json`）

```jsonc
{
  "channels": [
    {
      "id": "my-openai",                       // kebab-case 唯一 id
      "kind": "openai-queue",                  // openai-queue | gemini-queue
      "label": "OpenAI",                       // 前端展示用
      "baseUrl": "https://api.openai.com/v1",  // 上游真实地址（BFF 私有）
      "auth": {
        "type": "bearer",                      // bearer | query-key
        "secretRef": "MY_OPENAI_KEY"           // 环境变量名，UPPER_SNAKE_CASE
      },
      "models": [
        { "id": "gpt-image-2", "label": "GPT Image 2", "capabilities": ["generate", "edit"] }
      ],
      "defaults": { "apiMode": "images", "codexCli": false, "timeout": 600 },
      "allowedPaths": ["images/generations", "images/edits"]
    }
  ]
}
```

启动时 BFF：
1. zod-free 手写 schema 校验（详见 `apps/bff/src/lib/channels.ts`）
2. `secretRef` 必须 UPPER_SNAKE_CASE，且不能长得像真 key（防误提交）
3. `process.env[secretRef]` 没值时**只 warn 不 fatal** — channel 仍出现在 `/api/channels` 响应里，调用时再失败
4. 通过 `/api/channels` 暴露给前端时去掉 `baseUrl` / `auth` / `allowedPaths` 等私有字段

## 环境变量

复制 `.env.example` 到 `.env`，填入实际值：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `37377` | BFF 监听端口 |
| `DATABASE_URL` | sqlite file locally; `postgres://…` in TKE | Task store. Production must be Postgres. |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | — | Pixel store. Bucket `ai-images`, prefix `image-playground/` only. Lifecycle 7 days on that prefix — never the whole bucket. |
| `CORS_ALLOWED_ORIGINS` | `*` | CORS 允许的浏览器 origin，多个用逗号分隔；生产请收紧 |
| `STATIC_DIR` | `(空)` | 设为 `apps/web/dist` 让 BFF 同进程托管前端 |
| `CHANNELS_FILE` | `(空)` | 覆盖 `apps/bff/channels.json` 路径 |
| `<channel secretRef>` | — | 见 channels.json 里各 channel `auth.secretRef` 字段引用的 env 名 |

## 本地开发

```bash
# 在仓库根
pnpm install

# 跑 BFF（首次会自动 migrate）
cd apps/bff
cp .env.example .env
# 编辑 .env 填入 secret env
pnpm dev
```

测试：

```bash
pnpm test       # bun test，单测 + 路由集成
pnpm typecheck  # tsc --noEmit
```

## 部署

仓库根目录的 `Dockerfile` 把 web 构建 + BFF 打到一个镜像里：

```bash
docker build -t ai-image-playground .
docker run -p 37377:37377 \
  -e BFF_ENABLED=true \
  -e MY_OPENAI_KEY=sk-... \
  -v $(pwd)/apps/bff/channels.json:/app/apps/bff/channels.json \
  ai-image-playground
```

裸跑（systemd / pm2 / supervisord 等任一进程管理器）：

```bash
pnpm install
pnpm --filter @image-playground/web build
cd apps/bff
STATIC_DIR=../web/dist MY_OPENAI_KEY=sk-... bun run src/index.ts
```

进程管理器需要给至少 `SHUTDOWN_HARD_TIMEOUT_MS`（55s）+ 缓冲的优雅退出时间，否则 inflight 上游 fetch 会被 SIGKILL 中断（任务在 sqlite 里挂成 `interrupted`）。

详细的部署形态（纯静态 vs 静态+BFF）见仓库根 `README.md`。

## 任务状态机

```
queued → in_progress → completed
                     ↘ failed (upstream / network error)
                     ↘ cancelled (手动 cancel)
                     ↘ interrupted (BFF 被 SIGKILL 时遗留)
```

- `queued`: submit 刚写入数据库，worker 还没拿到
- `in_progress`: worker 已经 fetch 上游，等待响应
- `completed`: 成功，`result_payload` 字段含上游原始响应
- `failed`: 上游 HTTP error / 网络故障，`error_message` + `error_type` 记录
- `cancelled`: 手动调 cancel
- `interrupted`: 启动 recovery 标记的「上次未跑完且不能盲目重试」的任务

## 鉴权

**BFF 自身不做应用层鉴权**（不强制 API key）。实际安全靠以下组合形成防护链，按部署形态选用：

1. **CORS Origin 限制**（`CORS_ALLOWED_ORIGINS`）：只允许指定 origin，浏览器跨源 fetch 被 preflight 拦截
2. **反向代理 / tunnel 的 access policy**：如 Cloudflare Access、Authelia、nginx auth 等，把 BFF 放在认证墙后
3. **BFF URL 不公开**：通过私有 tunnel 域名暴露，仅前端 `runtime-config.json` 里出现，不进公开仓库

> ⚠️ 这条链**不防** "拿到 BFF URL + curl 伪造 Origin" 的攻击者。如果需要硬防，给反向代理加 Bearer / OAuth 中间件，或在 BFF 路由层加 auth middleware。
