# Admin Dashboard 设计文档

## 目标

给项目持有者（**单人自用**）一个能看 BFF SQLite 数据的后台：

- 哪些设备发了多少请求
- 每个 task 的提交参数、响应状态、生成结果（含输出图、参考图）
- 配额使用情况

**纯只读**。不做封禁、不做删除、不做配额重置。后续要写操作再加。

## 约束 / 决策

- **使用者**：仅本人，单密码登录
- **风格**：跟 C 端 `apps/web` 视觉/交互对齐
- **部署形态**：admin 独立端口（mac mini :37378）+ 独立 Cloudflare tunnel hostname，不寄生 BFF
- **栈**：跟 C 端齐头并进 → React 19 + Vite 6 + TS 5.8 + Tailwind v4 + Vitest 4
- **新增基线**：TanStack Router + TanStack Query + shadcn + Radix + lucide-react + RHF + Zod（为后续扩展打底）
- **不引 Zustand**：admin 服务器态全归 Query，URL 态全归 Router，纯 UI 态（Lightbox 等）也用 URL search params 表达，零客户端 store
- **后端**：Elysia + Bun + Drizzle（团队 BFF 基线），共享 SQLite（WAL，admin 只读）
- **配置加载**：跟 BFF `apps/bff/src/config.ts` 一致，手写 `env(key, fallback)` helper，**不引 Zod**（单人自用，过度校验意义不大；要换 Zod 应与 BFF 同步）
- **默认时间范围**：近 7 天
- **默认设备排序**：最近一次 task 提交时间降序
- **刷新策略**：手动刷新按钮，无自动轮询
- **只读语义**：限定于 SQLite 层（PRAGMA `query_only=ON`）；HTTP 层 cookie 写入（login/logout）不在此约束内
- **不做的事**：实时推送、批量操作、配额管理、设备封禁、task 删除、IP 限制、多账号

## 前置依赖（阻塞性）

admin 上线**依赖** per-device-quota（`docs/superpowers/specs/2026-05-15-per-device-daily-quota-design.md`）先落地代码。当前现状：

- `device_id` 字段在代码里**完全不存在**：`SubmitRequest` 类型、tasks.request_payload、daily_quota 表都还没有
- per-device-quota 只有 spec，没有 commit 实施

**两个选项**：

1. **顺序实施**（推荐）：先实施 per-device-quota（device_id 注入 + daily_quota 表 + quota gate），再开 admin 工程
2. **合并工程**：admin spec 实施时把 per-device-quota 也带上。注意工作量翻倍，PR 巨大

无论哪种，admin spec 的 SQL（`json_extract(request_payload, '$.device_id')`）和 UI（今日 12 / 50 配额条）都依赖 `device_id` 与 `daily_quota` 已存在。

## 架构

```
┌─ admin.image-playground.<root> ──────────────────────────┐
│ Cloudflare tunnel hostname → mac mini :37378            │
└──────────────────┬───────────────────────────────────────┘
                   │
        ┌──────────▼──────────────────┐
        │ apps/admin/server (Elysia)  │
        │  ├ POST /api/login          │  HMAC cookie 签发
        │  ├ POST /api/logout         │
        │  ├ GET  /api/me             │  Loader 用，校验 cookie
        │  ├ GET  /api/devices        │  ?range=7d&sort=last_seen
        │  ├ GET  /api/devices/:id    │  ?range=7d
        │  ├ GET  /api/tasks/:id      │
        │  ├ GET  /api/tasks/:id/image?idx=N         反代 BFF binary
        │  ├ GET  /api/tasks/:id/input-image?idx=N
        │  └ /*   serve apps/admin/dist
        └──────┬──────────────────────┘
               │ Drizzle 只读 SELECT (PRAGMA query_only=ON)
               │            │
               │            └─ fetch http://127.0.0.1:37377/v1/queue/.../binary (图片字节)
               ▼
        ┌──────────────────┐    ┌────────────────────────┐
        │ packages/db      │◄───┤ apps/bff (:37377)      │
        │  Drizzle schema  │    │  跑 migration、写 task   │
        │  createDb()      │    └────────────────────────┘
        └──────┬───────────┘
               │
               ▼
        image-playground.sqlite (WAL)
        admin: PRAGMA query_only=ON
        bff:   读写
```

**关键决定**：

1. admin server **直接读 SQLite**：WAL 模式多进程并发安全；admin 永不写
2. 图片字节 admin server **反代 BFF binary 端点**：复用 `extractMeta` + `resolveImageBytesRef`，不重写 base64 解码
3. **零持久化 session**：HMAC 签名 cookie 内含 `expires_at`，admin server 重启不掉登录
4. **Schema 共享**：BFF + admin 都从 `packages/db` import，BFF 跑 migration，admin 启动只 connect

## Monorepo 改造

### 新建 `packages/db/`

```
packages/db/
├─ package.json              # @image-playground/db
├─ tsconfig.json
├─ drizzle.config.ts         # 从 apps/bff 迁过来（仅供 drizzle-kit generate 参考）
└─ src/
   ├─ index.ts               # 导出 schema + createDb + runMigrations + checkpointWal
   ├─ schema.ts              # 从 apps/bff/src/db/schema.ts 迁过来
   ├─ migrate.ts             # 从 apps/bff/src/db/migrate.ts 迁过来
   └─ client.ts              # createDb(dbPath, { readonly?: boolean })
```

**Migration 风格保持现状**：BFF 当前 `migrate.ts` 是**手写 DDL** `sqlite.exec(DDL_BASE)` + 列存在检查兼容老库，**不依赖 drizzle-kit migrate runtime**（兼容性原因，见现有注释）。`packages/db/migrate.ts` 沿用这一风格，drizzle-kit 仅用于本地 `generate` 看 SQL 参考。**不**新建 `packages/db/migrations/` 目录。

`client.ts` 关键行为：

- `createDb(dbPath, { readonly?: boolean })` 工厂函数
- WAL pragma 收敛到工厂：`PRAGMA journal_mode=WAL`（幂等，多进程 connect 各自 exec 也无害）
- `readonly: true` 时额外 `PRAGMA query_only=ON`
- 同一文件多进程 connect 安全（SQLite WAL 文档保证）
- 暴露 `checkpointWal()` 给 BFF 关停钩子复用

### 新增索引 + 生成列（与 per-device-quota 同步落地）

```sql
-- 新增 daily_quota 表（per-device-quota spec 已设计）
CREATE TABLE IF NOT EXISTS daily_quota (
  device_id TEXT NOT NULL,
  date      TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, date)
);

-- admin 聚合需要：device_id 抽到独立索引列
ALTER TABLE tasks ADD COLUMN device_id TEXT
  GENERATED ALWAYS AS (json_extract(request_payload, '$.device_id')) VIRTUAL;
CREATE INDEX IF NOT EXISTS idx_tasks_device_id ON tasks(device_id);
-- idx_tasks_submitted_at 已存在（migrate.ts 现有 DDL）
```

DDL 加到 `runMigrations()` 函数的 `DDL_BASE` + ALTER 列存在检查（参考现有 `client_request_id` 列的 if-not-exists 风格做幂等）。

### BFF 改造

`apps/bff/src/db/*.ts` 全部改成 re-export `@image-playground/db`：

```ts
// apps/bff/src/db/client.ts
export { db, schema, checkpointWal } from '@image-playground/db'

// apps/bff/src/db/migrate.ts
export { runMigrations } from '@image-playground/db'
```

WAL pragma 不再在 BFF `client.ts` 顶层 exec，**收敛到** `packages/db/client.ts` 的 `createDb()` 工厂。BFF 业务代码 import 路径不变。

## Admin Server `apps/admin/server/`

### 目录

```
apps/admin/server/
├─ index.ts                 # Elysia app + listen :37378
├─ config.ts                # 手写 env() helper（同 BFF 风格）
├─ routes/
│  ├─ auth.ts               # /api/login, /api/logout, /api/me
│  ├─ devices.ts            # /api/devices, /api/devices/:id
│  ├─ tasks.ts              # /api/tasks/:id
│  └─ images.ts             # /api/tasks/:id/image, input-image
├─ lib/
│  ├─ constants.ts          # SESSION_COOKIE_NAME = 'admin_session' 等
│  ├─ session.ts            # HMAC sign/verify（Bun/Node 内置 crypto，零依赖）
│  ├─ middleware.ts         # requireAuth derive
│  ├─ rate-limit.ts         # 内存 LRU（max 1024 IP）
│  └─ queries.ts            # Drizzle 聚合封装
└─ static.ts                # 复用 BFF serveStatic + serveSpaFallback
```

**静态托管复用 BFF 实现**：`apps/bff/src/app.ts` 的 `serveStatic` + `cacheControlFor` + `serveSpaFallback` + gzip + MIME 表已经成熟（含 assets/* immutable、sw.js no-store 等策略）。落地路径二选一：

- (a) 抽到 `packages/server-utils/` 双方 import（推荐，避免后续演化分叉）
- (b) 直接复制到 admin（更轻，但两边各自演化）

spec 不固化，实施 PR 决定。SPA fallback 规则：未匹配 `/api/*` 的 GET 一律返 admin 的 `index.html`。

### 鉴权

**Cookie 格式**：`<expires_at_iso>.<hmac-sha256-base64url>`

```ts
// session.ts —— 用 Node/Bun 内置 crypto.createHmac，不引第三方
export function signSession(ttlMs = 7 * 86400_000): string
export function verifySession(cookieVal: string): { valid: boolean; expiresAt?: Date }
```

- secret = `ADMIN_COOKIE_SECRET` env，启动时 `config.ts` 强制至少 32 字符
- cookie attributes：`HttpOnly; Secure; SameSite=Lax; Path=/`，**Domain 留空**（host-only：admin.xxx 签发只在 admin.xxx 携带）
- TTL 7 天

**SameSite 选 Lax 不选 Strict**：Strict 下从外部链接（IM、邮件）首次点击进 admin 不带 cookie → 强制重新登录。admin 全是 GET 幂等 + 自用，CSRF 风险可控，Lax 是合适权衡。

**`POST /api/login`**：

```ts
body: { password: string }
// timingSafeEqual 对比 ADMIN_PASSWORD env
// 通过 → setCookie SESSION_COOKIE_NAME = signSession()
// 失败 → 401 { error: 'invalid_password' }
```

**`requireAuth` middleware**：

```ts
.derive(({ cookie, set }) => {
  const v = cookie[SESSION_COOKIE_NAME]?.value
  const { valid } = verifySession(v ?? '')
  if (!valid) { set.status = 401; throw new Error('unauthorized') }
  return { admin: true as const }
})
```

挂在 `/api/devices`、`/api/tasks`、`/api/me`、`/api/logout` 上；`/api/login` 不挂。

**暴力破解保护**：内存 LRU，键 = IP（X-Forwarded-For 取首段，Cloudflare tunnel 转发会带），**max 1024 entries** 满后 LRU 淘汰最老。5 次失败 / 60 秒 → 锁 10 分钟，返 429。admin 重启清空（自用，可接受）。

### 查询封装 `lib/queries.ts`

全部走 Drizzle（铁律 1）。**类型定义局部**：`Range` / `SortKey` 放 `apps/admin/server/lib/queries.ts` 内部 + 导出给前端 share，**不**污染 `packages/shared/`（那里只放跨 app 的协议）。

```ts
type Range = '1d' | '7d' | '30d'
type SortKey = 'last_seen' | 'today_count' | 'total_count'
```

#### 1. `listDevices(range, sort)` —— 单条聚合 SQL

`GROUP BY device_id` + 多个聚合一次拿全，**严禁 N+1**。用 `db.execute(sql\`...\`)`（铁律 1 例外条款：复杂聚合 query builder 表达不了，仍参数化）：

```sql
SELECT device_id,
  MIN(submitted_at) AS first_seen,
  MAX(submitted_at) AS last_seen,
  COUNT(*) AS total,
  SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS ok_count,
  SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS fail_count,
  GROUP_CONCAT(DISTINCT model) AS models_csv   -- 前端切前 3
FROM tasks
WHERE submitted_at >= ?
  AND device_id IS NOT NULL
GROUP BY device_id
ORDER BY <sort>
LIMIT 500
```

返回结构：

```ts
type ListDevicesResult = {
  devices: DeviceRow[]
  truncated: boolean        // 命中 500 上限时为 true
}
```

`daily_quota`（今日 12 / 50）单独一条 `SELECT device_id, count FROM daily_quota WHERE date = ? AND device_id IN (...)`，在 JS 层 zip。两条查询用 `Promise.all` 并发。

#### 2. `getDeviceDetail(deviceId, range)`

两条查询 `Promise.all` 并发：

- device meta：上面的聚合 SQL 加 `WHERE device_id = ?`
- task 列表：**select 字段白名单**（**不取 result_payload**）：

```ts
db.select({
  id: tasks.id,
  provider: tasks.provider,
  model: tasks.model,
  status: tasks.status,
  submitted_at: tasks.submitted_at,
  started_at: tasks.started_at,
  completed_at: tasks.completed_at,
  error_type: tasks.error_type,
  // request_payload 取（用于 prompt 文本，体积可控）
  request_payload: tasks.request_payload,
  // result_payload 不取（5-10MB），仅靠 status + 缩略图 idx 数量推断
}).from(tasks).where(...).limit(500)
```

> task 列表的小缩略图怎么知道有几张图？方案：在 `runTask` 完成时把图数量写到 `tasks.status` 旁边的新列 `result_image_count INTEGER`（迁移加列 + 回填），或者**接受**列表不显示缩略图，详情才显。spec 默认**后者**：列表只显示 `n=4` 占位文本，不渲染缩略图。

返回结构 `{ device: DeviceRow, tasks: TaskRow[], truncated: boolean }`，500 同样 truncated 标记。

#### 3. `getTask(taskId)` —— 仅详情接口 SELECT result_payload，server 端抽 meta 后剔除

```ts
const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
const result_meta = extractMeta(task.provider, task.result_payload)  // 复用 BFF lib
const { result_payload, ...taskOut } = task
return { ...taskOut, result_meta }  // 5-10MB 字节不出 server，前端只拿到 meta
```

### 反代图片端点

```ts
// GET /api/tasks/:id/image?idx=N
// 1. requireAuth
// 2. SELECT provider, model FROM tasks WHERE id=?     ← 字段白名单，不取 result_payload
//    这条 SELECT 是 admin 鉴权确认（"该 task 是 admin 可见的"），非 TOCTOU；不可省
// 3. fetch BFF_INTERNAL_URL + /v1/queue/${provider}/${model}/result/${taskId}/binary?idx=${N}
// 4. stream response body 回客户端 + 转发 content-type / content-length
// 5. 设 Cache-Control: private, max-age=600
//    （图字节与 task_id + idx 一对一不可变，long cache 不影响"手动刷新"语义——
//     刷新刷的是元数据/状态，图字节本身永远不变）
```

**短 TTL 内存缓存 task meta**：n=4 任务一次详情会触发 4 次 `/image?idx=N` 端点，每次都 SELECT 一次。加 in-memory LRU（max 200 entries, TTL 30s）缓存 `taskId → {provider, model}`，单 task 多图请求合并为一次 SELECT。

为什么反代不让前端直调 BFF：

- BFF binary 端点目前用 task_id 当 capability token，无鉴权
- 让 admin 前端直调 BFF 需要跨域 + BFF 放 CORS 给 admin 域名
- 反代后所有图片走 admin 鉴权链路，统一

### 参考图（input-image）

```ts
// GET /api/tasks/:id/input-image?idx=N
// 1. requireAuth
// 2. SELECT provider, request_payload FROM tasks WHERE id=?
//    task 不存在 → 404 { error_code: 'task_not_found' }
// 3. 复用 apps/bff/src/lib/extractImages.ts 的 input-image 抽取（Gemini inlineData）
//    抽到 → stream 返回 + Cache-Control: private, max-age=3600
//    抽不到（OpenAI multipart 路径未存档）→
//      422 { error_code: 'input_image_not_archived' }
// 4. 前端按 error_code 区分"未存档"（灰条）与"task 不存在"（错误页）
```

**已知边界**：OpenAI 图生图走 multipart 直传 sub2api，BFF 未持久化原图字节。admin 详情显示「参考图未存档」灰条。后续如要存档需 BFF 改造（不在本 spec 范围）。

**实施前提**：`apps/bff/src/lib/extractImages.ts` 当前的 input-image 抽取逻辑（Gemini `contents[].parts[].inlineData`）需要先确认覆盖 admin 用例；若仅覆盖输出图，则把抽 input-image 的纯函数提到 `packages/server-utils/` 或 `packages/db/lib/` 共用。

### 环境变量

```sh
# apps/admin/server/.env
ADMIN_PASSWORD=<明文，单人自用，无需 bcrypt>
ADMIN_COOKIE_SECRET=<至少 32 字节随机串>
BFF_INTERNAL_URL=http://127.0.0.1:37377
DB_PATH=/Users/qiqian/workspace/repos/qlj-image-playground/artifacts/image-playground.sqlite
PORT=37378
```

Zod 校验 fail-fast：缺一个不启动。

## Admin Frontend `apps/admin/src/`

### 路由（TanStack Router file-based）

```
apps/admin/src/routes/
├─ __root.tsx                  # 顶栏 layout（logo + range 切换 + refresh + logout）
├─ index.tsx                   # 重定向 → /devices
├─ login.tsx
└─ _authed/                    # layout route，beforeLoad 校验 /api/me，401 → redirect /login
   ├─ devices/
   │  ├─ index.tsx             # 设备列表
   │  └─ $deviceId.tsx         # 设备详情：task 列表 + Sheet 抽屉 / 全屏 lightbox
   └─ tasks.$taskId.tsx        # 任务独立 deeplink，渲染同一个 TaskDetailView，
                               # beforeLoad 找到该 task 的 device_id 后 redirect
                               # 到 /devices/$deviceId?task=$taskId&fullscreen=1
```

**为什么独立 deeplink 路由立刻 redirect**：避免"抽屉 URL"和"全屏 URL"两条路径维护同一视图。所有视图状态归一到 `/devices/$deviceId?task=...&fullscreen=...`，TanStack Query key 也只有一个 `['task', taskId]`，缓存复用。

### Search params 类型化

- `/devices?range=7d&sort=last_seen` — `range: '1d'|'7d'|'30d'`，`sort: SortKey`
- `/devices/$deviceId?range=7d&task=<id>&fullscreen=1` — `task` 存在时打开 Sheet；`fullscreen=1` 时打开 Dialog lightbox 全屏看图

切 range / sort 直接更新 URL。

### 顶栏

- Logo / 标题 → 点回 `/devices`
- Range segmented control（1d / 7d / 30d）
- Refresh 按钮 → `queryClient.invalidateQueries()`
- 当前用户标识（"admin"）+ Logout 按钮

### 数据获取（TanStack Query）

```ts
queryClient defaults:
  staleTime: Infinity    // 显式 refetch 才动
  gcTime: 5 min
  retry: false

// Query key 约定（全 spec 唯一来源）：
//   ['devices', { range, sort }]     → useDevices(range, sort)
//   ['device', deviceId, { range }]  → useDeviceDetail(deviceId, range)
//   ['task', taskId]                  → useTask(taskId)   ← 抽屉 + redirect 后的全屏页同 key
```

**顶栏 Refresh 按钮行为**：

```ts
queryClient.invalidateQueries({ queryKey: ['devices'] })   // mark stale，下次访问自动 refetch
queryClient.invalidateQueries({ queryKey: ['device'] })
queryClient.invalidateQueries({ queryKey: ['task'] })
// 不用 queryClient.clear()，保留 gcTime 内的内存缓存，单纯标 stale
```

**切 range 时**：URL 变化触发 router re-load，新 query key 与旧 key 不同，旧数据进 gcTime 倒计时；不主动 `removeQueries`（5 min 内重切回来还能命中缓存）。

**401 拦截**：全局 fetch wrapper，401 → `router.navigate({ to: '/login' })` + `queryClient.clear()`（登出强制清缓存）。

### 视图

#### 设备列表

shadcn Table：

| 列 | 内容 |
|---|---|
| Device | 8 位短码 + copy 按钮 + tooltip 全 UUID |
| First Seen | 选定 range 内最早 task `submitted_at`，模糊时间 |
| Last Active | 默认排序键 desc，模糊时间 |
| Today | `12 / 50` + Radix Progress 进度条 |
| Range 总数 | range 内 task 数 |
| 成功 / 失败 | succeeded / failed 计数 |
| Models | 模型 chip 列表，最多 3 个 + `+N more` |

#### 设备详情

顶部 device 卡：
- Full UUID + copy
- 今日 `12 / 50`、近 7 天累计、成功 / 失败 / 运行中
- 模型使用 chip 列表

下方 task 列表 Table：

| 列 | 内容 |
|---|---|
| 提交时间 | ISO + 距今 |
| Status | shadcn Badge（succeeded / failed / running / queued） |
| Model | model 名 |
| Prompt | 截 80 字 + tooltip 全文 |
| 图数 | `n=4` + 48x48 缩略图 inline（成功时） |
| 耗时 | `completed_at - started_at` |
| 操作 | 「查看」按钮 |

点行任意位置或缩略图打开抽屉 `?task=<id>`。

#### 任务详情（`TaskDetailView` 组件 → 抽屉 + 全屏页复用）

```
┌─ Header: task_id 短码 + copy / status badge / submitted_at ─┐
│                                                              │
│ ┌─ Request ───────────┐  ┌─ Result ──────────────────────┐  │
│ │ Provider: openai    │  │ status: succeeded             │  │
│ │ Model:    gpt-image │  │ duration: 24s                 │  │
│ │ Size:     1024x1024 │  │                                │  │
│ │ N:        4         │  │ ┌──┐ ┌──┐ ┌──┐ ┌──┐  输出图   │  │
│ │ Quality:  high      │  │ │ ▣│ │ ▣│ │ ▣│ │ ▣│           │  │
│ │                     │  │ └──┘ └──┘ └──┘ └──┘           │  │
│ │ Prompt:             │  │                                │  │
│ │   <全文>            │  │ error_message: (空)            │  │
│ │                     │  │                                │  │
│ │ 参考图（图生图时）：  │  │                                │  │
│ │ ┌──┐ ┌──┐           │  │                                │  │
│ │ │ ▣│ │ ▣│           │  │                                │  │
│ │ └──┘ └──┘           │  │                                │  │
│ └─────────────────────┘  └────────────────────────────────┘  │
│                                                              │
│ 点图片 → 全屏 Lightbox（shadcn Dialog）                       │
└──────────────────────────────────────────────────────────────┘
```

图片来源：
- 输出图：`<img src="/api/tasks/:id/image?idx=N" />`
- 参考图：`<img src="/api/tasks/:id/input-image?idx=N" />`（OpenAI 任务返 404 → 显示「参考图未存档」灰条）

## 部署

### `pnpm deploy:local`（修改入口：仓库根 `package.json` 的 `deploy:local` script）

扩展现有命令链（参考 commit 4a26922 的格式）：

```sh
# 1. build web（现有）
pnpm --filter @image-playground/web build

# 2. build admin（新增）
pnpm --filter @image-playground/admin build

# 3. 重启 bff（现有）—— migration 在 BFF 启动里跑
launchctl kickstart -k gui/$(id -u)/qlj.image-playground.bff

# 4. 重启 admin（新增）—— 必须在 bff 之后
launchctl kickstart -k gui/$(id -u)/qlj.image-playground.admin

# 5. 重启 cloudflared（commit 4a26922 已加）
launchctl kickstart -k gui/$(id -u)/qlj.cloudflared-macmini
```

**顺序要求**：bff 必须先于 admin 起（migration 在 BFF 启动里跑，admin 只 connect）。launchctl kickstart 是阻塞的，按上面顺序天然满足。

### mac mini launchd

新增 `~/Library/LaunchAgents/qlj.image-playground.admin.plist`：

- Label: `qlj.image-playground.admin`
- ProgramArguments: `bun run apps/admin/server/index.ts`
- WorkingDirectory: `/Users/qiqian/workspace/repos/qlj-image-playground`
- EnvironmentVariables: 从 `apps/admin/.env` 加载（参考 BFF agent 现有方式）
- StandardOutPath / StandardErrorPath: 独立 log 文件
- KeepAlive: true

### Cloudflare tunnel

现有 `cloudflared-macmini` 配置 ingress 新增一条规则指向 `:37378` 的 admin hostname；优先于 `:37377` 的 web hostname。具体 hostname 与 cert 在 runbook 里维护，spec 不固化。

## 测试

| 文件 | 覆盖 |
|---|---|
| `packages/db/__tests__/client.test.ts` | createDb readonly mode 屏蔽 INSERT |
| `packages/db/__tests__/queries.test.ts` | listDevices 单条聚合（验证不 N+1）/ range 过滤 / 三种 sort / 500 上限 truncated 标记 |
| `apps/admin/server/__tests__/lib/session.test.ts` | HMAC sign/verify / 过期 / 篡改 / secret 不一致 |
| `apps/admin/server/__tests__/lib/rate-limit.test.ts` | 5 次 → 锁 / 10 分钟后解锁 |
| `apps/admin/server/__tests__/routes/auth.test.ts` | login 正确 → 200 + cookie / 错误 → 401 / IP 锁 → 429 / logout 清 cookie |
| `apps/admin/server/__tests__/routes/devices.test.ts` | mock db，devices 列表带 range / 详情 404 / 未鉴权 401 |
| `apps/admin/server/__tests__/routes/images.test.ts` | 反代 BFF（mock fetch）/ 转发 content-type / openai input-image 返 422 + `error_code: 'input_image_not_archived'` / task 不存在返 404 + `error_code: 'task_not_found'` / task-meta LRU 缓存命中 / 未鉴权 401 |
| `apps/admin/src/__tests__/lib/api-client.test.ts` | 401 时 navigate /login + clear query cache |
| `apps/admin/src/__tests__/routes/login.test.tsx` | 表单提交 / 错误提示 / 成功后 navigate /devices |

测试库 **Vitest**（CLAUDE.md 偏好，admin server 也用 vitest，除非碰到 bun-only API）。

## 风险 / 已知边界

- **OpenAI 图生图参考图看不到**：sub2api 走 multipart，BFF 未持久化原图。详情页该处显示「参考图未存档」灰条。后续如要存档需 BFF 改造（不在本 spec 范围）
- **result_payload 大体积**：高 n 成功任务 base64 能达 5-10MB。admin 列表查询用 select 字段白名单**不取** result_payload；仅详情接口取，且 server 端 `extractMeta` 后剔除再返前端
- **admin 写并发**：当前 100% 只读，PRAGMA query_only=ON 守住。未来加写操作（重置配额等）需重审并发风险
- **暴力破解**：内存 LRU 单实例够用；admin 进程重启清空 → 攻击窗口 5 次重试。自用可接受
- **Cookie scope**：host-only（admin.xxx 签发，不跨子域）；admin 和 web 不共享登录态
- **Migration 协调**：admin server 启动时若 schema 不匹配（BFF 还没跑完 migration），admin Drizzle 报错 → launchd KeepAlive 重启重试。deploy 脚本顺序保证先 BFF 后 admin，正常路径不触发
- **Tailwind v4 试点**：admin 是第一个 v4 用户；C 端仍 v3。admin `index.css` 内联 C 端当前 token 映射（zinc 色板 + 三字体族 + media dark），实现细节交给执行 PR；后续 C 端升 v4 时一起抽到 `packages/ui-tokens`
- **TanStack Router file-based**：需配 `@tanstack/router-vite-plugin` + 生成路由树文件。生成产物入 git 或加 build step，按官方推荐做

## 范围外（后续 spec）

- 写操作：重置配额 / 封禁设备 / 删除 task
- 多账号 / 角色
- 实时推送（WebSocket / SSE）
- 历史趋势图（按日成功率、模型分布）
- OpenAI 图生图参考图存档
- Token / cost 统计
- 跨多设备的指纹合并
