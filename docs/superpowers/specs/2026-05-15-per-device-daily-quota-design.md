# 按设备每日生图配额（每日 50 张）

## 目标

防止匿名用户（不带 BYOK key）无限消耗 BFF 后端的 sub2api 配额。最小侵入：不上账号体系，靠浏览器 localStorage 持有的设备 ID + BFF SQLite 计数。

## 约束 / 决策

- **粒度**：按输出图数 n（一次 n=4 的 submit 扣 4）
- **限额**：50 张 / 设备 / 日（常量名 `DAILY_QUOTA_LIMIT`，放 `packages/shared/src/queue-protocol.ts`，前后端共用）
- **BYOK 豁免**：BYOK profile 根本不走 BFF，天然豁免，无需额外逻辑
- **时区**：UTC 0 点重置（北京时间 8 点）。日期键 `YYYY-MM-DD`，`new Date().toISOString().slice(0,10)`
- **UI**：无常驻显示。仅当 BFF 返 429 时 toast 提示
- **退款**：不退。任务失败 / 用户取消 都不退（先简单，看反馈再说）
- **持久化清理**：暂不清理（10 万设备 × 365 天 ≈ 22MB，远低于关切阈值）
- **没做的边界**：Turnstile、IP 限制、设备指纹强化都不做；用户清 localStorage 重置一次配额是已知容忍点

## 架构

```
浏览器
  ├─ 首次加载：lazy 读 localStorage['image-playground.device_id']
  │           缺失则 crypto.randomUUID() 写入
  └─ submitTask → queueClient.submit body 加 device_id 字段
                   ↓
BFF POST /v1/queue/:provider/:model/submit
  ├─ Body schema 加 device_id: t.Optional(t.String({minLength: 8, maxLength: 64}))
  ├─ tryConsumeQuota(device_id, n)
  │   原子 SQL：INSERT ... ON CONFLICT DO UPDATE SET count = count + ?
  │           WHERE daily_quota.count + ? <= 50
  │           RETURNING count
  │   返 ok: false 时即超额（RETURNING 空）
  ├─ 超额 → status(429, { error: 'daily_quota_exceeded', limit: 50, reset_at: <ISO> })
  └─ 通过 → 既有 spawnTask 流程不动
                   ↓
浏览器 queueClient.submit
  ├─ res.status === 429 + body.error === 'daily_quota_exceeded'
  │   抛 QuotaExceededError(reset_at)
  └─ store.executeTask 捕获 → showToast('今日 50 张已用完，UTC 0 点（北京 8 点）后重置')
```

## 数据模型

`apps/bff/src/db/schema.ts` 新表：

```ts
export const daily_quota = sqliteTable(
  'daily_quota',
  {
    device_id: text('device_id').notNull(),
    date: text('date').notNull(),                  // 'YYYY-MM-DD' UTC
    count: integer('count').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.device_id, t.date] }),
  }),
)
```

drizzle 生成 migration → 写入 BFF 启动 runMigrations。

## 不变量

- `setWhere`（`count + n <= DAILY_QUOTA_LIMIT`）只作用于 ON CONFLICT 的 UPDATE 分支。首次 INSERT 路径不查 limit，依赖 submit schema 已有 `n ∈ [1, 16]` 保证 `n ≤ DAILY_QUOTA_LIMIT`，因此首次插入必不超额。**未来如果调整 `n` 上限或 `DAILY_QUOTA_LIMIT`，必须重检此不变量**（否则可能写入 count > limit）。

## 关键函数

### 1. `apps/web/src/lib/deviceId.ts`（新文件）

```ts
const STORAGE_KEY = 'image-playground.device_id'
let cached: string | null = null

export function getDeviceId(): string {
  if (cached) return cached
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && stored.length >= 8) {
      cached = stored
      return cached
    }
    const fresh = crypto.randomUUID()
    localStorage.setItem(STORAGE_KEY, fresh)
    cached = fresh
    return cached
  } catch {
    // SSR / 隐私模式：用 in-memory ID 兜底（重启即新设备，可接受）
    if (!cached) cached = crypto.randomUUID()
    return cached
  }
}
```

### 2. `apps/bff/src/lib/quota.ts`（新文件）

```ts
import { sql } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { DAILY_QUOTA_LIMIT } from '@image-playground/shared'

export interface QuotaConsumeResult {
  ok: boolean
  /** 当前累计（成功时为更新后的值；失败时为消费前的累计） */
  count: number
  reset_at: string  // ISO UTC midnight tomorrow
}

export function currentQuotaDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function nextResetISO(): string {
  const tomorrow = new Date()
  tomorrow.setUTCHours(24, 0, 0, 0)
  return tomorrow.toISOString()
}

export async function tryConsumeQuota(
  device_id: string,
  n: number,
): Promise<QuotaConsumeResult> {
  const date = currentQuotaDate()
  // SQLite 单写者，无竞争。RETURNING 在 ON CONFLICT 时仅当 SET 真正命中。
  // 用 WHERE 守住 limit；超额则 UPDATE 不命中行 → RETURNING 空。
  const rows = await db
    .insert(schema.daily_quota)
    .values({ device_id, date, count: n })
    .onConflictDoUpdate({
      target: [schema.daily_quota.device_id, schema.daily_quota.date],
      set: { count: sql`${schema.daily_quota.count} + ${n}` },
      setWhere: sql`${schema.daily_quota.count} + ${n} <= ${DAILY_QUOTA_LIMIT}`,
    })
    .returning({ count: schema.daily_quota.count })

  if (rows.length === 0) {
    // 冲突且 setWhere 未命中：超额。读当前值给前端展示
    const [existing] = await db
      .select({ count: schema.daily_quota.count })
      .from(schema.daily_quota)
      .where(sql`device_id = ${device_id} AND date = ${date}`)
      .limit(1)
    return { ok: false, count: existing?.count ?? DAILY_QUOTA_LIMIT, reset_at: nextResetISO() }
  }
  return { ok: true, count: rows[0]!.count, reset_at: nextResetISO() }
}
```

### 3. `apps/bff/src/routes/submit.ts`（改造）

```ts
// schema 加字段
device_id: t.String({ minLength: 8, maxLength: 64 }),
// （注意：改为 required，匿名也必须带 ID。空 / 缺字段返 400）

// 业务流：
const n = body.n ?? 1
const quota = await tryConsumeQuota(body.device_id, n)
if (!quota.ok) {
  return status(429, {
    error: 'daily_quota_exceeded',
    limit: DAILY_QUOTA_LIMIT,
    used: quota.count,
    reset_at: quota.reset_at,
  })
}
// 后续保持原有 INSERT tasks + spawnTask 不变
```

### 4. `apps/web/src/lib/channels/queueClient.ts` submit body

```ts
const body: Record<string, unknown> = {
  prompt: ...,
  ...
  device_id: getDeviceId(),
}
```

错误识别：

```ts
if (res.status === 429) {
  const json = await res.json().catch(() => null)
  if (json?.error === 'daily_quota_exceeded') {
    const e = new Error(`今日 50 张已用完，UTC 0 点（北京 8 点）后重置`)
    ;(e as any).quotaExceeded = true
    ;(e as any).resetAt = json.reset_at
    throw e
  }
}
```

### 5. `apps/web/src/store.ts` executeTask 错误处理

`callImageApi` 抛错时，已有 `showToast(err.message, 'error')` 流程，无需新增；只要错误 message 是用户可读中文即可。

## 测试

### BFF

1. **`apps/bff/src/__tests__/lib/quota.test.ts`**（新）
   - `tryConsumeQuota('dev-1', 5)` → ok=true, count=5
   - 连续消费到 50 → 第 51 次（n=1）返 ok=false, count=50
   - 跨日期（mock 时间）→ 新日期重新从 0 开始
   - 并发 5 个 n=10 调用 → 总只能消费 50（剩下的 ok=false）
2. **`apps/bff/src/__tests__/routes/routes.test.ts`** 加：
   - submit 缺失 device_id → 400
   - submit 累计到 50 后第 51 次 → 429 + body.error === 'daily_quota_exceeded'

### Web

3. **`apps/web/src/__tests__/lib/deviceId.test.ts`**（新）
   - 第一次调用 → 写 localStorage + 返 UUID
   - 第二次 → 返同一 ID（缓存）
   - localStorage 抛错 → fallback in-memory ID
4. **`apps/web/src/__tests__/lib/api.test.ts`** 加：
   - builtin-edge submit body 含 `device_id` 字段
   - mock 429 + `daily_quota_exceeded` → 抛中文错误

## 部署 / 迁移

- 加 drizzle migration 文件（drizzle-kit generate）
- BFF 启动 runMigrations 自动应用，无需停机
- 旧 client 还没带 device_id 字段时：schema 默认是 required，会被 400 拒绝。需在前端 deploy 后再 deploy BFF？反之亦然，**先 deploy 前端再 deploy BFF** —— 旧前端不带 device_id，新 BFF 会拒。但实际部署是同步的 `pnpm deploy:local`（前端构建 + BFF 重启），原子性约可接受。
- 如果完全不能停顿：device_id 设为 optional，缺失时给一个 'anonymous' fallback ID（同 ID 共享配额）—— 但这违背设计。**推荐：device_id required，部署前 5 秒断流可接受。**

## 风险 / 已知边界

- 用户清 localStorage → 重置一次配额。能容忍（最小侵入路线，本就如此）
- 多 tab 同步：localStorage 同源共享，多 tab 用同一 device_id，配额合并 → 正确
- 隐私模式 / SSR：deviceId.ts try/catch 返 in-memory ID，每个 session 独立但同 session 内一致
- iOS Safari ITP：localStorage 在 7 天闲置后清理，类似"清 localStorage"
- 时钟漂移：服务器用 `new Date().toISOString()`，不依赖客户端时钟，安全
- BFF 重启：count 持久化在 SQLite，无损
