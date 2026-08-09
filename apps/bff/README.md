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
- **应用层 auth 是部署级可选项**。`AUTH_ENABLED=false` 保留个人部署的匿名行为；
  设为 `true` 后，channel 与全部 queue 端点要求有效账号会话，并按 `user_id`
  隔离任务。CORS 与反向代理 access policy 仍是必要的外围防线。
- **能力配置 deny by default**。`OPERATOR_CONFIG_FILE` 不存在时全部能力关闭；文件存在但
  JSON 或 schema 无效时拒绝启动。预设只在解析时展开，运行时只保留求值结果与来源。
  `AUTH_ENABLED` 的调用点暂时保留，后续按独立语义切换到能力。

## 端点

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/health` | liveness |
| `GET` | `/api/capabilities` | 公开只读清单；只返回注册表中显式允许下发给浏览器的能力 |
| `POST` | `/api/auth/login` | 账号密码登录，签发 HttpOnly session cookie（仅 auth 开启时） |
| `POST` | `/api/auth/logout` | 撤销当前 session |
| `GET` | `/api/auth/me` | 查询当前账号 / auth 开关状态 |
| `GET` | `/api/channels` | 返回 sanitized channel 列表；auth 开启时需登录 |
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

## Operator 配置与私有树

从 [`operator-config.example.json`](./operator-config.example.json) 复制安全样例到仓库外，
通过 `OPERATOR_CONFIG_FILE=/run/operator/operator-config.json` 指向它。顶层
`preset` 选择同文件 `presets` 中的定义；预设先展开，随后由顶层 `capabilities`
覆盖。`quotas` 是独立的数值命名空间，不得把数值写进能力表。`config` 留给 channel、
品牌和内容文件路径及 secret 环境变量名；真实业务值和 secret 不放进样例或仓库。

根目录 `private/` 是被忽略的可选 overlay。公开工作树默认没有该目录，BFF 经唯一的
`apps/bff/src/lib/private-overlay.ts` 接缝加载它；目录缺席时返回可运行的空插件。
Biome 禁止其它公开代码静态或动态引用 `private/`。

## 环境变量

复制 `.env.example` 到 `.env`，填入实际值：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `37377` | BFF 监听端口 |
| `DATABASE_URL` | `../../artifacts/image-playground.sqlite` | SQLite 文件路径 |
| `S3_ENDPOINT` | — | S3-compatible object storage endpoint, such as the internal MinIO URL |
| `S3_BUCKET` | — | Deployment-specific image bucket |
| `S3_ACCESS_KEY_ID` | — | Object storage access key; keep the real value outside git |
| `S3_SECRET_ACCESS_KEY` | — | Object storage secret key; keep the real value outside git |
| `CORS_ALLOWED_ORIGINS` | `*` | CORS 允许的浏览器 origin，多个用逗号分隔；生产请收紧 |
| `STATIC_DIR` | `(空)` | 设为 `apps/web/dist` 让 BFF 同进程托管前端 |
| `CHANNELS_FILE` | `(空)` | 覆盖 `apps/bff/channels.json` 路径 |
| `OPERATOR_CONFIG_FILE` | `(空)` | 仓库外 operator JSON；缺失使用关闭默认值，存在但无效则拒绝启动 |
| `AUTH_ENABLED` | `false` | 是否启用账号登录与任务归属校验；必须是 `true` 或 `false` |
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
  -e AUTH_ENABLED=false \
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
- `completed`: 成功，`result_payload` 保留上游元数据与对象键；像素字节只存 S3
- `failed`: 上游、网络或对象存储故障，`error_message` + `error_type` 记录
- `cancelled`: 手动调 cancel
- `interrupted`: 启动 recovery 标记的「上次未跑完且不能盲目重试」的任务

## 鉴权

`AUTH_ENABLED=false`（默认）时，BFF 保持原来的匿名兼容模式。适用于自用、
已经处于可信网络或另有统一认证墙的部署。

`AUTH_ENABLED=true` 时：

- `/api/channels` 与 `/v1/queue/*` 全部要求有效 session；
- 登录 Cookie 使用 `HttpOnly`、`Secure`、`SameSite=Lax`，生产必须通过 HTTPS；
- 数据库仅保存 session token 的 SHA-256，不保存原 token；
- 任务在入队时绑定 `user_id`，状态、结果、图片和取消接口都校验归属；
- 禁用账号、重置密码或后台“退出会话”会撤销该账号的现有 session；
- 登录失败分别按来源 IP 和归一化账号限速，错误响应不区分“账号不存在”和“密码错误”。

账号由 Admin 服务创建，不提供公开注册。Web 与 BFF 必须使用相同的
`AUTH_ENABLED` 值；Docker entrypoint 会把它写入 Web 的
`runtime-config.json.auth.enabled`，但真正的安全判断始终由 BFF 执行。

应用层登录之外，实际部署仍应组合以下外围防线：

1. **CORS Origin 限制**（`CORS_ALLOWED_ORIGINS`）：只允许指定 origin，浏览器跨源 fetch 被 preflight 拦截
2. **HTTPS 与安全响应头**：由 Cloudflare / nginx / ingress 终止 TLS
3. **Admin 单独保护**：Admin 域名不要公开暴露，至少再加 Cloudflare Access、VPN 或 IP allowlist
4. **精确 CORS**：认证部署不要保留 `*`，填经营站点的实际 origin

> CORS 不是认证机制，curl 等非浏览器客户端不受它限制。是否有权调用最终由
> session 与路由归属校验决定。
