# @image-playground/bff

任务队列 BFF：Elysia + Bun + Drizzle + PostgreSQL。为 `apps/web` 提供异步图像生成入口，绕开浏览器 / Edge / CF Pages 之类平台的 100s idle timeout，让 Gemini 3 Pro Image 这类 30s-15min 长任务可以稳定跑完。

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
- **账号登录是能力，不是部署开关**。`accounts:login` 由 operator 配置在启动时求值；
  未配置时默认关闭。任务归属、幂等归属和图片缓存策略不读能力开关，而从任务行及当前
  请求的用户身份推导，因此关闭账号能力不会公开已有的用户任务。
- **能力配置 deny by default**。`OPERATOR_CONFIG_FILE` 不存在时全部能力关闭；文件存在但
  JSON 或 schema 无效时拒绝启动。预设只在解析时展开，运行时只保留求值结果与来源。
- **账号计量与部署能力分离**。`billing:credits` 表示部署具备积分模块；私有 overlay 可在任务事务内
  返回账号级 metered / unmetered / denied 决策。未提供策略时保留部署原有行为；无效策略拒绝提交。
  图片、视频、分析和文本任务保存 `metering` 快照，完成与取消按该快照决定是否结算，已有空快照
  沿用旧结算路径。不计量任务不预扣、不结算，账号配额由独立事务 hook 消费，幂等回放不重复消费。
  Agent 对话的不计量路径不创建用于账务的聊天任务，但保留对话轮和模型用量。
  部署关闭计费与账号明确不计量分开处理：只有后者消费账号额度。聊天价格 hook 可接收当前事务，
  overlay 应复用该连接，避免小连接池里嵌套获取连接。身份解绑可由私有账号策略拒绝，返回
  `409 protected_identity`，不会删除登录身份或改变其账号归属。

## 端点

| Method | Path | 说明 |
|---|---|---|
| `GET` | `/health` | liveness |
| `GET` | `/api/capabilities` | 公开只读清单；只返回注册表中显式允许下发给浏览器的能力 |
| `POST` | `/api/auth/login` | 账号密码登录，签发 HttpOnly session cookie（需 `accounts:login`） |
| `POST` | `/api/auth/logout` | 撤销当前 session（需 `accounts:login`） |
| `GET` | `/api/auth/me` | 查询当前账号（需 `accounts:login`） |
| `GET` | `/api/channels` | 返回 sanitized channel 列表；账号登录能力开启时需登录 |
| `POST` | `/v1/queue/{provider}/{model}/submit` | 入队，立即返回 `request_id` |
| `GET` | `/v1/queue/requests/{id}/status` | 状态查询（含 queue_position / started_at 等）|
| `GET` | `/v1/queue/requests/{id}` | 拿结果（`completed` 时含 `payload`；其它状态 425）|
| `PUT` | `/v1/queue/requests/{id}/cancel` | 取消（in_progress 仅标记，worker 完成时会覆盖）|
| `POST` | `/api/sync` | 一次请求既推也拉模板 / 素材 / 用户设置（需 `accounts:sync` + 登录）|
| `PUT` | `/api/sync/assets/{imageId}` | 上传素材图本体；`imageId` 是内容哈希（需 `accounts:sync` + 登录）|
| `GET` | `/api/sync/assets/{imageId}` | 下载自己的素材图；别人的 `imageId` 一律 404（需 `accounts:sync` + 登录）|

请求 / 响应 schema 见 [`packages/shared/src/queue-protocol.ts`](../../packages/shared/src/queue-protocol.ts) 和 [`packages/shared/src/channel-discovery.ts`](../../packages/shared/src/channel-discovery.ts)。

### 图片能力与提案估价

GPT 渠道能力、会员门禁与实际选路共用启用密钥判断，读取相同的直连开关和密钥来源；
声明支持直连不代表当前预算或并发可用，这些限制仍在派发时检查。
Gemini 的 Vertex 和普通网关请求都按渠道开放档位规整，未开放的 4K 不会原样透传。
批量、阶段授权、模板和自动提交的提案估价使用提交时相同的会员收口：非会员的 Gemini 4K
先降到 2K，再按渠道可用档位取倍率。会员身份独立于 GPT 直连开关；仅当会员身份会改变有效报价时，
前端才等待查询结果，基础档、纯视频和渠道已降到同一档的请求不受会员查询失败影响。

### CLI 图片预检与提交

`POST /v1/image-jobs/validate` 与 `POST /v1/image-jobs` 共用参数规整与 GPT 档位倍率。
GPT Image 2.5 的 2K、4K、`quality=high` 需要有效会员且 OpenAI 直连已配置；CLI 在预检与
提交事务内都检查，不能使用时返回 `PLAN_REQUIRED`，不创建任务、不留积分预扣。网站队列入口
仍保留原有降到基础档的行为。能力清单仅列出当前账号可提交的 GPT 档位和画质。
严格约束随任务持久化：执行时直连关闭、预算耗尽、限流或并发额度不可用，以及直连明确失败时，
不回落到忽略档位的 sub2api；任务失败返回 `PLAN_REQUIRED` 并走原有退款流程。已派发但结果
未知的请求仍交给原有对账流程，不伪装成确定失败、不重复派发。基础档 CLI 和网站的换路行为不变。

GPT 2K/4K 必须落到具体像素尺寸；省略比例或传 `aspect_ratio=auto` 时规整为 `1:1`，并在
预检和提交响应的 `adjustments` 中明确返回 `{ field: 'ratio', from: 'auto', to: '1:1' }`。
明确指定的受支持比例保持不变。预检的 `normalized`、`request_hash` 与提交使用的参数一致。

`max_credits` 是预算前置条件，不是命令身份：0 表示不允许预扣任何积分。提交重新读取报价，
再以同一事务中实际预扣的积分数兜底；实际预扣超过上限时整个事务回滚（包括任务与预扣），
返回 `MAX_CREDITS_EXCEEDED`。拒绝不消耗幂等键；已成功提交的同键同参数请求仍返回原任务，
不受后来会员或价格变化影响，也不重复预扣。

云端回归（需 `TEST_DATABASE_URL`）：`pnpm --dir apps/bff test --filter routes/cli.test.ts`。

## provider 路由

`{provider}` URL 段决定 BFF 向上游发什么协议：

- `openai-compat` → `POST ${channel.baseUrl}/images/generations`（或 `/images/edits` 当带参考图 / mask），OpenAI Images API 标准 body
- `gemini` → `POST ${channel.baseUrl}/models/{model}:generateContent`，Google 原生 generateContent body

channel kind `openai-queue` / `gemini-queue` 在前端层用，到 BFF URL 就转成 `openai-compat` / `gemini`（参见 `apps/web/src/lib/channels/queueClient.ts` 的 `toQueueProvider`）。

纯文生图 `n>1`：OpenAI Images channel 声明 `n` 能力时，使用一次 generations 请求并保留 `n`；
通用网关不根据 `gpt-image-*` 模型名推断原生多图能力，而是逐张请求、合并结果，每次派发分别记账。
配置了 Responses 桥接时，多图同样逐张调用，不向图片工具发送不支持的 `n`。
带参考图 / mask 的请求及其余兼容路径保持逐图 fan-out。异步任务恢复使用持久化的已派发请求数，
不因路由变化补发旧原生批次；缺少已派发任务 ID 时仍报告结果未知，不重复提交。

## Channel 配置（`apps/bff/channels.json`）

```jsonc
{
  "channels": [
    {
      "id": "my-openai",                       // kebab-case 唯一 id
      "kind": "openai-queue",                  // openai-queue | gemini-queue
      "label": "OpenAI",                       // 前端展示用
      "baseUrl": "https://api.openai.com/v1",  // 上游真实地址（BFF 私有）
      // 或 "baseUrlRef": "MY_UPSTREAM_BASE_URL"  // 二选一：地址也从 env 取（须 https）
      // "requiresSecret": true,                // 缺 key 就整条丢弃（直连上游用），缺省只 warn
      // "maxConcurrency": 2,                   // 仅 gemini-queue：本进程同时在途请求上限（含多张拆出的每条）
      "auth": {
        "type": "bearer",                      // bearer | query-key
        "secretRef": "MY_OPENAI_KEY"           // 环境变量名，UPPER_SNAKE_CASE
      },
      "models": [
        { "id": "gpt-image-2.5-flare", "label": "GPT Image 2.5 Flare", "capabilities": ["generate", "edit"] }
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
   - 声明了 `requiresSecret: true` 的 channel 例外：缺 key 时**整条丢弃**，不进发现清单（`veo-video` 这类直连上游没 key 只是个必然失败的模型）
   - `baseUrlRef` 指的 env 值必须能 `new URL()` 解析出主机名，且协议为 `https:`（`localhost` / `127.0.0.1` / `::1` 允许 `http:`）——channel key 随请求一起发出，明文 http 会把它送上网络
   - 该 env 没值或不合法时同样只 warn，但该 channel **整条丢弃**：没有上游地址就拼不出请求
4. 通过 `/api/channels` 暴露给前端时去掉 `baseUrl` / `auth` / `allowedPaths` / `maxConcurrency` 等私有字段

## Operator 配置与私有树

从 [`operator-config.example.json`](./operator-config.example.json) 复制安全样例到仓库外，
通过 `OPERATOR_CONFIG_FILE=/run/operator/operator-config.json` 指向它。顶层
`preset` 选择同文件 `presets` 中的定义；预设先展开，随后由顶层 `capabilities`
覆盖。`quotas` 是独立的数值命名空间，不得把数值写进能力表。`config` 留给 channel、
品牌和内容文件路径及 secret 环境变量名；真实业务值和 secret 不放进样例或仓库。

### 配额

| Key | 缺省值 | 说明 |
|---|---|---|
| `agent:compaction-buffer-tokens` | `13000` | 压缩阈值相对有效窗口留的缓冲 |
| `agent:compaction-cooldown-minutes` | `360` | 摘要连续失败后的熔断时长 |
| `agent:compaction-failure-threshold` | `3` | 触发熔断的连续失败次数 |
| `agent:compaction-keep-tokens` | `20000` | 压缩后保留原文的最近消息预算（token） |
| `agent:compaction-output-reserve-tokens` | `20000` | 有效窗口给输出留的 token |
| `agent:compaction-verbatim-tokens` | `20000` | 摘要里逐字保留用户原话的 token 上限 |
| `generation:daily-images` | `0` | 每设备每日生成张数上限（需 `quota:daily`）|
| `sync:asset-image-bytes` | `10485760`（10 MB）| 单张素材图上传字节上限 |
| `sync:user-asset-bytes` | `524288000`（500 MB）| 每用户素材图总字节上限 |

开了 `billing:credits` 的部署把 `AGENT_CHAT_MODEL` 当成一个计价模型登记进单价表，计价单位是
`kilo_token`：每单位积分数即每千输入 token 的积分，行上另存每千输出 token 的积分与一轮预扣的
输出 token 上限（B 档 6 / 30 / 2000）。首次启动自动登记一行，之后运营在后台改，改完下一轮生效；
没有有效单价时起轮返回 422 `model_price_unavailable`。

超过任一素材图上限时 `PUT /api/sync/assets/{imageId}` 返回 `413`，body 为
`{ "error": "asset_image_too_large" | "asset_storage_quota_exceeded", "limit": <字节> }`，
对象与台账都不落。被拒的素材在客户端照常本地可用，只是标「未同步」；对应的素材记录
在 `POST /api/sync` 里会被单独拒绝（`rejected` 里给 `asset_image_missing`），同批其它
记录照常接受。同一个 `imageId` 重复上传直接成功且只计一次字节。

根目录 `private/` 是被忽略的可选 overlay。公开工作树默认没有该目录，BFF 经唯一的
`apps/bff/src/lib/private-overlay.ts` 接缝加载它；目录缺席时返回可运行的空插件。
Biome 禁止其它公开代码静态或动态引用 `private/`。

## 环境变量

复制 `.env.example` 到 `.env`，填入实际值：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `37377` | BFF 监听端口 |
| `DATABASE_URL` | — | PostgreSQL connection URL；BFF/worker 使用可写角色 |
| `DATABASE_POOL_MAX` | `10` | 本进程最多同时持有的数据库连接数（BFF、worker、Admin 通用），须为正整数，否则拒绝启动；超出的查询排队等待。Compose 部署按角色写在 `deploy/compose.app.yaml`（发布脚本 `scripts/rollout-runtime.sh` 同步），`app.env` 里设了也会被覆盖 |
| `DATABASE_IDLE_TIMEOUT_SECONDS` | `60` | 连接空闲这么久就关闭，须为正整数。Bun 同样会切断静默这么久的单条语句或事务，调小前先确认没有更长的等待 |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `60000` | 服务端 `statement_timeout`：单条语句超过这么久由 PostgreSQL 取消（BFF、worker、Admin 通用，迁移不受限）。须为正整数 |
| `DATABASE_LOCK_TIMEOUT_MS` | `10000` | 服务端 `lock_timeout`：等行锁、表锁或 advisory lock 超过这么久就报错，不再排队干等 |
| `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` | `60000` | 服务端 `idle_in_transaction_session_timeout`：事务开着却这么久没发语句，服务端断开它并释放锁 |
| `S3_ENDPOINT` | — | S3-compatible object storage endpoint, such as the Cloudflare R2 account URL |
| `S3_BUCKET` | — | Deployment-specific image bucket |
| `S3_ACCESS_KEY_ID` | — | Object storage access key; keep the real value outside git |
| `S3_SECRET_ACCESS_KEY` | — | Object storage secret key; keep the real value outside git |
| `S3_KEY_PREFIX` | `(空)` | 对象 key 前缀；bucket 与其他业务共用时用它隔离，DB 里存的 ref 不含前缀 |
| `CORS_ALLOWED_ORIGINS` | `*` | CORS 允许的浏览器 origin，多个用逗号分隔；生产请收紧。作为 OAuth 前端 allowlist 的回退时，每项必须是 bare `http(s)` origin |
| `AUTH_PUBLIC_ORIGIN` | `(空)` | OAuth provider 注册的主 BFF 回调 origin；配置后必须是 bare `http(s)` origin，回调为 `<origin>/api/auth/oauth/{provider}/callback` |
| `AUTH_PUBLIC_ORIGINS` | `(空)` | 允许保持当前请求回调主机的精确 API allowlist，逗号分隔的 bare `http(s)` origins；只填写路由到同一 BFF 的可信 API origin，未匹配时仍使用主 `AUTH_PUBLIC_ORIGIN` |
| `AUTH_FRONTEND_ORIGIN` | `(空)` | OAuth 登录完成后的默认前端 origin；必须是 bare `http(s)` origin |
| `AUTH_FRONTEND_ORIGINS` | `(空)` | OAuth 登录回跳的精确 allowlist，逗号分隔的 bare `http(s)` origins；浏览器 start/link URL 显式携带当前 origin，Origin header 缺失时仍安全回跳 |
| `AUTH_LOGIN_METHODS_BY_ORIGIN` | `{}` | 按精确前端 origin 配置登录入口，完整例子见下文。键必须是 frontend allowlist 中的标准 bare origin，值必须包含 boolean `password`、boolean `registration` 和 provider ID 数组；未知字段或无效值拒绝启动 |
| `STATIC_DIR` | `(空)` | 设为 `apps/web/dist` 让 BFF 同进程托管前端 |
| `CHANNELS_FILE` | `(空)` | 覆盖 `apps/bff/channels.json` 路径 |
| `OPERATOR_CONFIG_FILE` | `(空)` | 仓库外 operator JSON；缺失使用关闭默认值，存在但无效则拒绝启动 |
| `<channel secretRef>` | — | 见 channels.json 里各 channel `auth.secretRef` 字段引用的 env 名 |

登录入口配置只决定该站点提供哪些登录方式，不决定用户计量、授权或已登录 session 的权限。
未配置的 allowlisted origin 保留原有密码、邮箱注册与已启用 OAuth provider；显式 `providers: []`
禁用该入口的所有 OAuth provider。`registration` 指邮箱/密码自助注册，不关闭已允许 OAuth
provider 的首次登录建号；邮箱注册还要求 `password: true` 与 `accounts:self-register` 能力。

`GET /api/auth/oauth/providers?frontend_origin=<origin>` 返回过滤后的 `providers` 与
`loginMethods: { password, registration }`。浏览器 `Origin` header 优先于发现接口的 query；
密码登录、注册、验证码及设置密码的 POST 只读 `Origin`，缺失时使用请求本身的 API origin，
从不使用 query 选择较宽松的策略。同源反代部署应为其 API origin 配置对应入口策略。
配置策略后，未知/畸形来源会被拒绝；OAuth 导航 start/link 仍可通过 allowlisted
`frontend_origin` 选择入口，回调核对与 provider/state 绑定的返回 origin，并重新核对 provider
是否允许。CLI device/token 接口及已有 session 不受此入口策略影响；用户仍可从其它允许的站点登录。

### 共享 BFF 的双入口配置

qlj / studio 与 muvloom 前端使用同一套启用 overlay 的应用与同一个 muvloom BFF，但登录入口分别配置。
以下值仅为公开通用示例，`enterprise` 是私有 provider ID 的占位值，不会凭此自动注册 provider：

```dotenv
AUTH_PUBLIC_ORIGIN=https://muvloom-api.example.com
AUTH_PUBLIC_ORIGINS=https://muvloom-api.example.com,https://enterprise-api.example.net
AUTH_FRONTEND_ORIGIN=https://muvloom.example.com
AUTH_FRONTEND_ORIGINS=https://muvloom.example.com,https://enterprise.example.net,https://studio.example.net
CORS_ALLOWED_ORIGINS=https://muvloom.example.com,https://enterprise.example.net,https://studio.example.net
AUTH_LOGIN_METHODS_BY_ORIGIN='{"https://enterprise.example.net":{"password":false,"registration":false,"providers":["enterprise"]},"https://studio.example.net":{"password":false,"registration":false,"providers":["enterprise"]},"https://muvloom.example.com":{"password":true,"registration":true,"providers":["google"]}}'
```

所有仍对用户开放的前端域名（包括旧域名）都应显式填写规则，否则 allowlisted 但未配置的入口
仍保留默认登录方式。`accounts:login` 与 `accounts:self-register` 保持开启以保留 muvloom 密码注册；
企业入口的 `registration: false` 只禁用该入口的邮箱 / 密码注册，不是关闭共享部署的注册能力。
Google 的 client ID / secret、私有 provider 配置及真实业务值只留在仓库外配置中。

发布前需要分别确认三类 allowlist，不能互相替代：

1. **浏览器请求**：`CORS_ALLOWED_ORIGINS` 精确允许前端 origin，不用 `*`。
2. **登录返回**：`AUTH_FRONTEND_ORIGINS` 包含每个入口；策略的键必须在其中。
3. **provider 回调**：保持主 `AUTH_PUBLIC_ORIGIN`，在 `AUTH_PUBLIC_ORIGINS` 增加可信同站 API
   别名。别名必须实际路由到共享 BFF；可信 ingress 应覆盖 forwarded host / proto，而非透传任意
   客户端值。在 provider 管理台登记实际使用的完整回调 URL，例如
   `https://muvloom-api.example.com/api/auth/oauth/google/callback` 与
   `https://enterprise-api.example.net/api/auth/oauth/enterprise/callback`。
   若同一 provider 从多个 API origin 发起登录，每个组合都要登记。
   **缺少 provider 侧新回调 allowlist 是切换阻塞项**；代码配置只能校验 origin 格式，不能证明
   管理台已允许该 URL。新别名未加入 BFF allowlist 时还会回退主回调主机，丢失原主机的 state cookie。

**共享后端不等于跨站调用。** qlj 前端的 Pages 配置应指向
`https://enterprise-api.example.net`，muvloom 前端指向 `https://muvloom-api.example.com`；两者最终进入
同一 BFF。会话 cookie 是 host-only、`SameSite=Lax`：qlj 前端若直接请求另一注册域的 muvloom API，
跨站 fetch 不会携带 cookie，即使 CORS 允许且使用 `credentials: include` 也无效。
OAuth start、callback 和后续 API 请求应保持同一 API 主机；不同主机上的旧会话不会自动转移。
不要用放宽 CORS、cookie Domain 或改成 `SameSite=None` 代替同站路由设计。

### qlj 前端与冻结的旧 qlj 后端

qlj 域名迁入共享 muvloom Pages 项目后，由 CI 通过 `pages-release.sh muvloom` 随同一份 overlay-enabled
构建产物发布，以按 host 生效的响应头禁止搜索索引；迁入前仍由冻结的旧 qlj Pages 项目服务。
仓库外的 `PAGES_ENV` 保留 `PAID_*` 项目配置；`INTERNAL_PUBLIC_ORIGIN` / `INTERNAL_BFF_BASE_URL`
只用于 qlj 域名的第一方 API 映射与 noindex 配置，后者指向共享 BFF 的同站 API 别名，而非旧 qlj 后端。
域名迁入需单独批准，按[部署手册](../../docs/deploy/image-release.md#企业域名迁入-muvloom-pages-项目一次性)执行；不要手工上传替代 CI。

旧 qlj BFF / worker / Admin 与其数据库、对象存储保持冻结，不因 qlj Pages 发布而覆盖、
重建或停用；`deploy/app.qlj.env.example` 仅作为旧部署参考。共享 BFF 配置见
`deploy/app.muvloom.env.example`。这是前端 / API 路由切换，**不代表旧 qlj 账号、会话、任务或资产
已经迁移**，也不应通过替换旧数据库 URL 或存储凭据来实现共享后端。
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

进程管理器需要给至少 `WORKER_DRAIN_TIMEOUT_MS`（默认 55s）+ 缓冲的优雅退出时间，否则 inflight 上游 fetch 会被 SIGKILL 中断。

详细的部署形态（纯静态 vs 静态+BFF）见仓库根 `README.md`。

## 任务状态机

```
queued → in_progress → completed
                     ↘ failed (upstream / network error / 重试用尽)
                     ↘ cancelled (手动 cancel)
                     ↗ 回到 queued (瞬时失败重试、worker 停机回收)
```

- `queued`: submit 刚写入数据库，worker 还没拿到
- `in_progress`: worker 已经 fetch 上游，等待响应
- `completed`: 成功，`result_payload` 保留上游元数据与对象键；像素字节只存 S3
- `failed`: 上游、网络或对象存储故障，`error_message` + `error_type` 记录
- `cancelled`: 手动调 cancel
- `error_type: interrupted`: worker 停机 / SIGKILL 打断且重试预算已用尽的任务

## Worker 停机与任务回收

SIGTERM 之后 worker 分三段收尾，目的是「部署不打断在途生成」：

1. scheduler 立刻停止领新任务（含 `next_retry_at` 已到期的重试）；
2. 在途任务继续跑满 `WORKER_DRAIN_TIMEOUT_MS`（默认 55s），窗口内跑完的正常写终态；
3. 窗口耗尽才 abort 剩余任务，随后按 `lib/retry.ts` 的重试预算把它们写回 `queued`
   （`attempt_count + 1`、`next_retry_at` 按退避梯度），下一个 worker 接着跑；
   预算用尽的才落终态 `failed`，让计费 reversal 正常发生。

`runTask` 自己对 abort 一律不写终态，终态归属由调用方决定：cancel route 的 abort
由 cancel route 写 `cancelled`；停机 abort 由 worker 入口点名交给 `recoverTasksByIds`。

`WORKER_DRAIN_TIMEOUT_MS` 调大能少一些重试（生图上游能跑 30-300s），代价是每次部署
停机时间同步变长。**改它必须连带调大进程管理器的停机宽限**（`deploy/compose.app.yaml`
的 `stop_grace_period`、systemd `TimeoutStopSec`、pm2 `kill_timeout`），否则先挨
SIGKILL，代码层 drain 无从谈起。

SIGKILL 没有 drain 的机会，行会留在 `in_progress`。worker 启动时扫一次、之后每 5 分钟
再扫（`recoverAbandonedTasks`）：`started_at` 超过 16 分钟（> 上游硬超时，活着的 runner
早该写终态了）且不在本进程在跑的行，按同一套重试语义回收。

## 鉴权与能力

`accounts:login` 默认关闭。要启用用户登录，在仓库外的 `operator-config.json` 中选择
`authenticated-example` 预设或显式设置该能力，并通过 `OPERATOR_CONFIG_FILE` 指向它。
前端只读取 BFF 的 `/api/capabilities` 清单；`runtime-config.json` 不包含能力开关。

能力开启时：

- `/api/channels` 与 `/v1/queue/*` 全部要求有效 session；
- 登录 Cookie 使用 `HttpOnly`、`Secure`、`SameSite=Lax`，生产必须通过 HTTPS；
- 数据库仅保存 session token 的 SHA-256，不保存原 token；
- 任务在入队时绑定 `user_id`，状态、结果、图片和取消接口都校验归属；
- 禁用用户、重置密码或后台“退出会话”会撤销该用户的现有 session；
- 登录失败分别按来源 IP 和归一化用户名限速，错误响应不区分“用户不存在”和“密码错误”。

运营者可以通过 Admin 创建用户。若同时启用 `accounts:self-register`，前端还会显示注册入口，
并开放 `POST /api/auth/register`；自助注册不能脱离 `accounts:login` 单独启用。带 `user_id`
的任务始终要求同一用户，即使以后关闭登录能力也不会退化为匿名可读；匿名任务仍可匿名访问。

应用层登录之外，实际部署仍应组合以下外围防线：

1. **CORS Origin 限制**（`CORS_ALLOWED_ORIGINS`）：只允许指定 origin，浏览器跨源 fetch 被 preflight 拦截
2. **HTTPS 与安全响应头**：由 Cloudflare / nginx / ingress 终止 TLS
3. **Admin 单独保护**：Admin 域名不要公开暴露，至少再加 Cloudflare Access、VPN 或 IP allowlist
4. **精确 CORS**：认证部署不要保留 `*`，填经营站点的实际 origin

> CORS 不是认证机制，curl 等非浏览器客户端不受它限制。是否有权调用最终由
> session 与路由归属校验决定。
