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
- **栈**：跟 C 端齐头并进 → React 19 + Vite 6 + TS 5.8 + Tailwind v4 + Zustand 5 + Vitest 4
- **新增基线**：TanStack Router + TanStack Query + shadcn + Radix + lucide-react + RHF + Zod（为后续扩展打底，"现在小后面就大了"前瞻）
- **后端**：Elysia + Bun + Drizzle（团队 BFF 基线），共享 SQLite（WAL，admin 只读）
- **默认时间范围**：近 7 天
- **默认设备排序**：最近一次 task 提交时间降序
- **刷新策略**：手动刷新按钮，无自动轮询
- **不做的事**：实时推送、批量操作、配额管理、设备封禁、task 删除、IP 限制、多账号

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
├─ drizzle.config.ts         # 从 apps/bff 迁过来
├─ migrations/               # 从 apps/bff/drizzle 迁过来（保留历史）
└─ src/
   ├─ index.ts               # 导出 schema + createDb
   ├─ schema.ts              # 从 apps/bff/src/db/schema.ts 迁过来
   ├─ migrate.ts             # 从 apps/bff/src/db/migrate.ts 迁过来
   └─ client.ts              # createDb(dbPath, { readonly?: boolean })
```

`client.ts` 关键行为：

- 启动时显式 `PRAGMA journal_mode=WAL`
- `readonly: true` 时额外 `PRAGMA query_only=ON`
- 同一文件多进程 connect 安全（SQLite 文档保证）

### 新增 schema migration

```sql
ALTER TABLE tasks ADD COLUMN device_id TEXT
  GENERATED ALWAYS AS (json_extract(request_payload, '$.device_id')) VIRTUAL;
CREATE INDEX idx_tasks_device_id ON tasks(device_id);
CREATE INDEX idx_tasks_submitted_at ON tasks(submitted_at);
```

理由：admin 设备列表 `GROUP BY device_id` + range filter 是热查询，没索引会全表扫。VIRTUAL 生成列不占额外空间，索引让聚合 < 10ms。Drizzle Kit 生成 migration 入 git。

### BFF 改造

`apps/bff/src/db/*.ts` 全部改成 re-export `@image-playground/db`：

```ts
// apps/bff/src/db/client.ts
export { db, schema } from '@image-playground/db'
```

BFF 业务代码零改动。

## Admin Server `apps/admin/server/`

### 目录

```
apps/admin/server/
├─ index.ts                 # Elysia app + listen :37378
├─ config.ts                # Zod 校验 env 启动
├─ routes/
│  ├─ auth.ts               # /api/login, /api/logout, /api/me
│  ├─ devices.ts            # /api/devices, /api/devices/:id
│  ├─ tasks.ts              # /api/tasks/:id
│  └─ images.ts             # /api/tasks/:id/image, input-image
├─ lib/
│  ├─ session.ts            # HMAC sign/verify
│  ├─ middleware.ts         # requireAuth derive
│  ├─ rate-limit.ts         # 内存 LRU
│  └─ queries.ts            # Drizzle 聚合封装
└─ static.ts                # serve apps/admin/dist + SPA fallback
```

### 鉴权

**Cookie 格式**：`<expires_at_iso>.<hmac-sha256-base64url>`

```ts
// session.ts
export function signSession(ttlMs = 7 * 86400_000): string
export function verifySession(cookieVal: string): { valid: boolean; expiresAt?: Date }
```

- secret = `ADMIN_COOKIE_SECRET` env，启动时 Zod 强制至少 32 字符
- cookie attributes：`HttpOnly; Secure; SameSite=Strict; Path=/`，**Domain 留空**（host-only：admin.xxx 上签发只在 admin.xxx 携带）
- TTL 7 天

**`POST /api/login`**：

```ts
body: { password: string }
// timingSafeEqual 对比 ADMIN_PASSWORD env
// 通过 → setCookie 'admin_session' = signSession()
// 失败 → 401 { error: 'invalid_password' }
```

**`requireAuth` middleware**：

```ts
.derive(({ cookie, set }) => {
  const v = cookie.admin_session?.value
  const { valid } = verifySession(v ?? '')
  if (!valid) { set.status = 401; throw new Error('unauthorized') }
  return { admin: true as const }
})
```

挂在 `/api/devices`、`/api/tasks`、`/api/me`、`/api/logout` 上；`/api/login` 不挂。

**暴力破解保护**：内存 LRU 记录 IP，5 次失败 / 分钟 → 锁 10 分钟，返 429。admin 重启清空（自用，可接受）。

### 查询封装 `lib/queries.ts`

全部走 Drizzle（铁律 1）。

```ts
type Range = '1d' | '7d' | '30d'
type SortKey = 'last_seen' | 'today_count' | 'total_count'

// 设备列表：join tasks + daily_quota，GROUP BY device_id，最多 500 条
listDevices(range: Range, sort: SortKey): Promise<DeviceRow[]>

// 设备详情：meta + range 内 task 列表（最多 500，超了截断 + 返 truncated: true）
getDeviceDetail(deviceId: string, range: Range): Promise<DeviceDetail>

// 任务详情：tasks 整行 + extractMeta() 抽图元数据（不含字节）
// 注意：列表查询不取 result_payload 字段，只详情时取
getTask(taskId: string): Promise<TaskDetail>
```

聚合用 `db.execute(sql\`...\`)` 走 Drizzle 的 sql 模板（铁律 1 例外条款：复杂聚合 query builder 表达不了），仍参数化。

### 反代图片端点

```ts
// GET /api/tasks/:id/image?idx=N
// 1. requireAuth
// 2. 读 tasks 拿 provider, model
// 3. fetch BFF_INTERNAL_URL + /v1/queue/${provider}/${model}/result/${taskId}/binary?idx=${N}
// 4. stream response body 回客户端 + 转发 content-type / content-length
// 5. 设 Cache-Control: private, max-age=600
```

为什么反代不让前端直调 BFF：

- BFF binary 端点目前用 task_id 当 capability token，无鉴权
- 让 admin 前端直调 BFF 需要跨域 + BFF 放 CORS 给 admin 域名
- 反代后所有图片走 admin 鉴权链路，统一

### 参考图（input-image）

```ts
// GET /api/tasks/:id/input-image?idx=N
// 1. requireAuth
// 2. 读 tasks 拿 request_payload + provider
// 3. provider === 'gemini'：从 request_payload.contents[].parts[].inlineData.data 解 base64 返回
//    provider === 'openai-compat'：返 404 + 提示 "OpenAI 参考图未存档"
// 4. 设 Cache-Control: private, max-age=3600
```

**已知边界**：OpenAI 图生图走 multipart 直传 sub2api，BFF 未持久化原图字节 → admin 详情该处显示「参考图未存档」灰条。

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
   │  └─ $deviceId.tsx         # 设备详情（含 task 列表 inline + Sheet 抽屉看单 task）
   └─ tasks/
      └─ $taskId.tsx           # 任务详情独立全屏页（deeplink 分享用）
```

### Search params 类型化

- `/devices?range=7d&sort=last_seen` — `range: '1d'|'7d'|'30d'`，`sort: SortKey`
- `/devices/$deviceId?range=7d&task=<id>` — `task` 存在时 Sheet 抽屉打开该任务

切 range / sort 直接更新 URL，不动 zustand。

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

// useDevices(range, sort)              → GET /api/devices
// useDeviceDetail(deviceId, range)      → GET /api/devices/:id
// useTask(taskId)                       → GET /api/tasks/:id
```

401 拦截：放在全局 fetch wrapper，401 → `router.navigate({ to: '/login' })` + `queryClient.clear()`。

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

### Zustand 仅放纯 UI 态

```ts
// 哪些不该进 zustand：服务器态、当前路由、search params（全归 TanStack Query / Router）
// 进 zustand：
// - Lightbox open + idx（如果不用 router state）
// - login form 临时态（其实直接 RHF，也不进 zustand）
// → 现阶段几乎不需要 zustand store，预留个空 store 文件就行
```

## 部署

### `pnpm deploy:local`（仓库根，扩展现有脚本）

```sh
# 1. build web（现有）
pnpm --filter @image-playground/web build

# 2. build admin（新增）
pnpm --filter @image-playground/admin build

# 3. 重启 bff（现有）
launchctl kickstart -k gui/$(id -u)/qlj.image-playground.bff

# 4. 重启 admin（新增）
launchctl kickstart -k gui/$(id -u)/qlj.image-playground.admin

# 5. 重启 cloudflared（保留 commit 4a26922 的修复）
launchctl kickstart -k gui/$(id -u)/qlj.cloudflared-macmini
```

**顺序要求**：bff 必须先于 admin 起（migration 必须先跑）。launchctl kickstart 是阻塞的，按上面顺序天然满足。

### mac mini launchd

新增 `~/Library/LaunchAgents/qlj.image-playground.admin.plist`：

- Label: `qlj.image-playground.admin`
- ProgramArguments: `bun run apps/admin/server/index.ts`
- WorkingDirectory: `/Users/qiqian/workspace/repos/qlj-image-playground`
- EnvironmentVariables: 从 `apps/admin/.env` 加载（参考 BFF agent 现有方式）
- StandardOutPath / StandardErrorPath: 独立 log 文件
- KeepAlive: true

### Cloudflare tunnel

现有 `cloudflared-macmini` 配置 ingress 加一行：

```yaml
ingress:
  - hostname: admin.<现有 web 域名根>
    service: http://localhost:37378
  - hostname: <现有 web 域名>
    service: http://localhost:37377
  - service: http_status:404
```

## 测试

| 文件 | 覆盖 |
|---|---|
| `packages/db/__tests__/client.test.ts` | createDb readonly mode 屏蔽 INSERT |
| `packages/db/__tests__/queries.test.ts` | listDevices 聚合 / range 过滤 / 三种 sort |
| `apps/admin/server/__tests__/lib/session.test.ts` | HMAC sign/verify / 过期 / 篡改 / secret 不一致 |
| `apps/admin/server/__tests__/lib/rate-limit.test.ts` | 5 次 → 锁 / 10 分钟后解锁 |
| `apps/admin/server/__tests__/routes/auth.test.ts` | login 正确 → 200 + cookie / 错误 → 401 / IP 锁 → 429 / logout 清 cookie |
| `apps/admin/server/__tests__/routes/devices.test.ts` | mock db，devices 列表带 range / 详情 404 / 未鉴权 401 |
| `apps/admin/server/__tests__/routes/images.test.ts` | 反代 BFF（mock fetch）/ 转发 content-type / openai input-image 返 404 |
| `apps/admin/src/__tests__/lib/api-client.test.ts` | 401 时 navigate /login + clear query cache |
| `apps/admin/src/__tests__/routes/login.test.tsx` | 表单提交 / 错误提示 / 成功后 navigate /devices |

测试库 **Vitest**（CLAUDE.md 偏好，admin server 也用 vitest，除非碰到 bun-only API）。

## 风险 / 已知边界

- **OpenAI 图生图参考图看不到**：sub2api 走 multipart，BFF 未持久化原图。详情页该处显示「参考图未存档」灰条。后续如要存档需 BFF 改造（不在本 spec 范围）
- **result_payload 大体积**：高 n 成功任务 base64 能达 5-10MB。admin 列表查询**不取** result_payload 字段；详情时才取
- **admin 写并发**：当前 100% 只读，PRAGMA query_only=ON 守住。未来加写操作（重置配额等）需重审并发风险
- **暴力破解**：内存 LRU 单实例够用；admin 进程重启清空 → 攻击窗口 5 次重试。自用可接受
- **Cookie scope**：host-only（admin.xxx 签发，不跨子域）；admin 和 web 不共享登录态
- **Migration 协调**：admin server 启动时若 schema 不匹配（BFF 还没跑完 migration），admin Drizzle 报错 → launchd KeepAlive 重启重试。deploy 脚本顺序保证先 BFF 后 admin，正常路径不触发
- **Tailwind v4 试点**：admin 是第一个 v4 用户；C 端仍 v3。C 端 token 实际很轻：`gray = zinc` 颜色映射 + 三个字体族基于 CSS 变量 + `darkMode: 'media'`。admin 落地时：
  - admin `index.css` 复制 C 端的 `--font-ui-sans / --font-display / --font-mono` CSS 变量定义
  - admin `index.css` 用 `@theme inline {}` 块声明 `--color-gray-* = zinc 色板`、`--font-sans / --font-display / --font-mono` 引用上述 CSS 变量
  - 后续 C 端升 v4 时把这些提到 `packages/ui-tokens` 共享（不在本 spec 范围）
- **TanStack Router file-based**：需配 `@tanstack/router-vite-plugin` + 生成路由树文件。生成产物入 git 或加 build step，按官方推荐做
- **C 端 device_id 注入路径**：spec 假设前端 submit 时已经塞 `request_payload.device_id`，依赖 commit 8f6066c 完成的 per-device-quota 设计。admin 上线前需确认该字段在新 task 上稳定写入

## 范围外（后续 spec）

- 写操作：重置配额 / 封禁设备 / 删除 task
- 多账号 / 角色
- 实时推送（WebSocket / SSE）
- 历史趋势图（按日成功率、模型分布）
- OpenAI 图生图参考图存档
- Token / cost 统计
- 跨多设备的指纹合并
