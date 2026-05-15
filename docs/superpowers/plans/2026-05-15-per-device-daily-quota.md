# Per-Device Daily Quota Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给匿名（无 BYOK）用户加 50 张 / 设备 / 日的图片生成配额，靠 localStorage device_id + BFF SQLite 单条原子 SQL 实现。

**Architecture:** 浏览器首次访问时 `crypto.randomUUID()` 生成 device_id 写 localStorage；每次 submit 把 device_id 带到 BFF。BFF 新表 `daily_quota(device_id, date, count)`，submit 路由先跑 `INSERT … ON CONFLICT DO UPDATE SET count = count + n WHERE count + n <= 50 RETURNING count` 原子拿额度，0 行返回 → 429。UTC 0 点（北京 8 点）按日期键自然重置。

**Tech Stack:** packages/shared 加常量 + 类型；BFF Elysia + Drizzle（bun-sqlite）+ bun:test；apps/web React + Zustand + Vitest。

**Spec reference:** `docs/superpowers/specs/2026-05-15-per-device-daily-quota-design.md`

---

## File Structure

**Create**:
- `apps/web/src/lib/deviceId.ts` — 浏览器 device_id getter（localStorage + in-memory fallback）
- `apps/web/src/__tests__/lib/deviceId.test.ts` — vitest
- `apps/bff/src/lib/quota.ts` — `tryConsumeQuota(device_id, n)` 原子配额扣减
- `apps/bff/src/__tests__/lib/quota.test.ts` — bun:test（依赖 bun:sqlite）

**Modify**:
- `packages/shared/src/queue-protocol.ts` — 加 `DAILY_QUOTA_LIMIT` 常量 + `SubmitRequest.device_id` 字段
- `apps/bff/src/db/schema.ts` — 加 `daily_quota` drizzle table 定义
- `apps/bff/src/db/migrate.ts` — `DDL_BASE` 加 `daily_quota` 建表 DDL
- `apps/bff/src/routes/submit.ts` — body schema 加 device_id（required）+ 调 `tryConsumeQuota` gate + 429
- `apps/bff/src/__tests__/routes/routes.test.ts` — 加 device_id 缺失 / 超额测试
- `apps/web/src/lib/channels/queueClient.ts` — submit body 加 `device_id` + 429 错误识别（抛中文 message）
- `apps/web/src/__tests__/lib/api.test.ts` — 加配额相关测试用例

**No changes**:
- `apps/web/src/store.ts` — 现有 `showToast(err.message, 'error')` 流程已覆盖 429 中文错误展示，无需改

---

### Task 1: Shared 常量 + 类型

**Files:**
- Modify: `packages/shared/src/queue-protocol.ts`

无单元测试（纯类型 + 常量）。下一个 task 编译时会校验。

- [ ] **Step 1: 加 DAILY_QUOTA_LIMIT 常量 + SubmitRequest.device_id**

修改 `packages/shared/src/queue-protocol.ts`：

```ts
// 在 SubmitRequest 接口里（client_request_id 后面）加：

  /**
   * 浏览器持久化的设备 ID（localStorage UUID）。BFF 用于按设备每日配额计数。
   * 前端 submitTask 时统一带；缺失或格式异常时 BFF 返 400。
   */
  device_id: string
```

把 `client_request_id?: string` 上面那行起注释保持原样，新增字段紧跟在 `client_request_id` 之后。

然后在文件末尾（紧挨 `QueueChannelView` 之前或之后均可，与 `QUEUE_TIMEOUTS` 同区域）加：

```ts
/**
 * 单设备单日最大生图张数。计数粒度是输出图数 n（n=4 的 submit 扣 4 张）。
 * 北京时间 8 点 / UTC 0 点重置。BYOK profile 不走 BFF，天然豁免。
 */
export const DAILY_QUOTA_LIMIT = 50
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: PASS — 注意此刻 BFF/web 代码还没传 `device_id`，但 TS 严格性不会立刻报错（SubmitRequest 在 BFF 的 schema.tsx 是 `.$type<SubmitRequest>()` 给运行时 cast，编译期不强制；前端 queueClient 用 `Record<string, unknown>` 构造 body 也绕过类型）。如果意外报错，提早 fix。

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/queue-protocol.ts
git commit -m "feat(shared): DAILY_QUOTA_LIMIT 常量 + SubmitRequest.device_id 字段"
```

---

### Task 2: BFF schema + migration

**Files:**
- Modify: `apps/bff/src/db/schema.ts`
- Modify: `apps/bff/src/db/migrate.ts`
- Test: `apps/bff/src/__tests__/lib/migrate.test.ts`（新建小测试覆盖建表）

- [ ] **Step 1: 写 migrate 单元测试（先失败）**

新建 `apps/bff/src/__tests__/lib/migrate.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { unlinkSync } from 'node:fs'
import { runMigrations } from '../../db/migrate'

const TEST_DB = './artifacts/test-migrate.sqlite'

describe('runMigrations', () => {
  it('creates daily_quota table with correct columns + primary key', () => {
    try {
      unlinkSync(TEST_DB)
      unlinkSync(`${TEST_DB}-wal`)
      unlinkSync(`${TEST_DB}-shm`)
    } catch {}

    runMigrations(TEST_DB)

    const sqlite = new Database(TEST_DB)
    const cols = sqlite.query('PRAGMA table_info(daily_quota)').all() as Array<{
      name: string
      notnull: number
      pk: number
    }>
    expect(cols.length).toBeGreaterThan(0)

    const byName = Object.fromEntries(cols.map((c) => [c.name, c]))
    expect(byName.device_id).toMatchObject({ notnull: 1, pk: 1 })
    expect(byName.date).toMatchObject({ notnull: 1, pk: 2 })
    expect(byName.count).toMatchObject({ notnull: 1, pk: 0 })

    sqlite.close()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/bff && bun test src/__tests__/lib/migrate.test.ts`
Expected: FAIL — `PRAGMA table_info(daily_quota)` 返回空数组，因 daily_quota 表还不存在。

- [ ] **Step 3: 加 drizzle table 定义到 schema.ts**

修改 `apps/bff/src/db/schema.ts`，在文件末尾（`Task` / `NewTask` 类型导出之前）加：

```ts
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
```

（如果 import 已有 `integer, sqliteTable, text`，仅追加 `primaryKey`）

然后在 `tasks` 表定义后追加：

```ts
export const daily_quota = sqliteTable(
  'daily_quota',
  {
    device_id: text('device_id').notNull(),
    date: text('date').notNull(), // 'YYYY-MM-DD' UTC
    count: integer('count').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.device_id, t.date] }),
  }),
)
```

- [ ] **Step 4: 加 daily_quota DDL 到 migrate.ts**

修改 `apps/bff/src/db/migrate.ts`，在 `DDL_BASE` 模板字符串里 tasks 表 + 索引之后追加（保持手写 DDL 风格，与现有 `CREATE TABLE IF NOT EXISTS` 一致）：

```ts
const DDL_BASE = `
  CREATE TABLE IF NOT EXISTS tasks (
    ... 现有内容不动 ...
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_submitted_at ON tasks(submitted_at);

  CREATE TABLE IF NOT EXISTS daily_quota (
    device_id TEXT NOT NULL,
    date      TEXT NOT NULL,
    count     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, date)
  );
`
```

注意 DDL 末尾的反引号位置和 tasks DDL 风格一致；不要破坏原有缩进。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd apps/bff && bun test src/__tests__/lib/migrate.test.ts`
Expected: PASS

- [ ] **Step 6: 跑全量 BFF 测试，确认没退化**

Run: `cd apps/bff && pnpm test`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add apps/bff/src/db/schema.ts apps/bff/src/db/migrate.ts apps/bff/src/__tests__/lib/migrate.test.ts
git commit -m "feat(bff): daily_quota 表 schema + migration"
```

---

### Task 3: BFF quota lib — `tryConsumeQuota`

**Files:**
- Create: `apps/bff/src/lib/quota.ts`
- Test: `apps/bff/src/__tests__/lib/quota.test.ts`

参考 spec 的"关键不变量"：`setWhere` 仅作用于 ON CONFLICT 的 UPDATE 分支；首次 INSERT 不查 limit，依赖 submit schema `n ∈ [1, 16]` 保证不超额。

- [ ] **Step 1: 写测试（先失败）**

新建 `apps/bff/src/__tests__/lib/quota.test.ts`：

```ts
import { beforeEach, describe, expect, it } from 'bun:test'
import { unlinkSync } from 'node:fs'

const TEST_DB = './artifacts/test-quota.sqlite'

try {
  unlinkSync(TEST_DB)
  unlinkSync(`${TEST_DB}-wal`)
  unlinkSync(`${TEST_DB}-shm`)
} catch {
  /* not exists */
}

process.env.DATABASE_URL = TEST_DB
process.env.SUB2API_BASE_URL = 'http://localhost:9999'
process.env.SUB2API_API_KEY = 'test'
process.env.CORS_ALLOWED_ORIGINS = '*'

const { runMigrations } = await import('../../db/migrate')
runMigrations(TEST_DB)
const { db, schema } = await import('../../db/client')
const { tryConsumeQuota, currentQuotaDate, nextResetISO } = await import('../../lib/quota')

async function resetQuota() {
  await db.delete(schema.daily_quota)
}

describe('tryConsumeQuota', () => {
  beforeEach(async () => {
    await resetQuota()
  })

  it('首次消费写入计数', async () => {
    const r = await tryConsumeQuota('dev-1', 5)
    expect(r.ok).toBe(true)
    expect(r.count).toBe(5)
    expect(r.reset_at).toBe(nextResetISO())
  })

  it('累计 5 次 n=10 到达 50', async () => {
    for (let i = 1; i <= 5; i++) {
      const r = await tryConsumeQuota('dev-1', 10)
      expect(r.ok).toBe(true)
      expect(r.count).toBe(i * 10)
    }
  })

  it('累计到 50 后第 51 次（n=1）返回 ok=false 且 count 保持 50', async () => {
    for (let i = 0; i < 5; i++) await tryConsumeQuota('dev-1', 10)
    const r = await tryConsumeQuota('dev-1', 1)
    expect(r.ok).toBe(false)
    expect(r.count).toBe(50)
  })

  it('单次 n 超出剩余额度（已 48，n=3）返回 ok=false 且 count 保持 48', async () => {
    await tryConsumeQuota('dev-1', 48)
    const r = await tryConsumeQuota('dev-1', 3)
    expect(r.ok).toBe(false)
    expect(r.count).toBe(48)
  })

  it('不同 device_id 各自独立计数', async () => {
    await tryConsumeQuota('dev-1', 50)
    const r = await tryConsumeQuota('dev-2', 50)
    expect(r.ok).toBe(true)
    expect(r.count).toBe(50)
  })

  it('currentQuotaDate 返 YYYY-MM-DD UTC', () => {
    const date = currentQuotaDate()
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(date).toBe(new Date().toISOString().slice(0, 10))
  })

  it('nextResetISO 返 ISO 字符串且对应 UTC 第二天 00:00:00', () => {
    const reset = nextResetISO()
    const d = new Date(reset)
    expect(d.getUTCHours()).toBe(0)
    expect(d.getUTCMinutes()).toBe(0)
    expect(d.getUTCSeconds()).toBe(0)
    expect(d.getTime()).toBeGreaterThan(Date.now())
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/bff && bun test src/__tests__/lib/quota.test.ts`
Expected: FAIL — `Cannot find module '../../lib/quota'`

- [ ] **Step 3: 写实现**

新建 `apps/bff/src/lib/quota.ts`：

```ts
import { DAILY_QUOTA_LIMIT } from '@image-playground/shared'
import { and, eq, sql } from 'drizzle-orm'
import { db, schema } from '../db/client'

export interface QuotaConsumeResult {
  ok: boolean
  /** 成功时是更新后的值；失败时是消费前的累计值。 */
  count: number
  /** 下次配额重置时间（UTC 第二天 00:00:00 ISO 字符串）。 */
  reset_at: string
}

export function currentQuotaDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export function nextResetISO(): string {
  const tomorrow = new Date()
  tomorrow.setUTCHours(24, 0, 0, 0)
  return tomorrow.toISOString()
}

/**
 * 单条原子 UPSERT：INSERT 命中或 ON CONFLICT UPDATE 命中 setWhere 都返回新 count；
 * 仅在 UPDATE 分支因 setWhere 不满足而不命中时返 0 行 → ok=false。
 *
 * 不变量：setWhere 仅作用于 UPDATE 分支。首次 INSERT 不查 limit，依赖 submit
 * 路由的 n ∈ [1, 16] 保证首次插入必不超额（n ≤ DAILY_QUOTA_LIMIT）。
 */
export async function tryConsumeQuota(
  device_id: string,
  n: number,
): Promise<QuotaConsumeResult> {
  const date = currentQuotaDate()

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
    const [existing] = await db
      .select({ count: schema.daily_quota.count })
      .from(schema.daily_quota)
      .where(
        and(eq(schema.daily_quota.device_id, device_id), eq(schema.daily_quota.date, date)),
      )
      .limit(1)
    return {
      ok: false,
      count: existing?.count ?? DAILY_QUOTA_LIMIT,
      reset_at: nextResetISO(),
    }
  }

  return { ok: true, count: rows[0]!.count, reset_at: nextResetISO() }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/bff && bun test src/__tests__/lib/quota.test.ts`
Expected: PASS — 7 个测试用例全过。

- [ ] **Step 5: 跑全量 BFF 测试**

Run: `cd apps/bff && pnpm test`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add apps/bff/src/lib/quota.ts apps/bff/src/__tests__/lib/quota.test.ts
git commit -m "feat(bff): tryConsumeQuota 原子配额扣减 lib"
```

---

### Task 4: BFF submit route — device_id schema + quota gate

**Files:**
- Modify: `apps/bff/src/routes/submit.ts`
- Modify: `apps/bff/src/__tests__/routes/routes.test.ts`

- [ ] **Step 1: 加 routes 测试（先失败）**

修改 `apps/bff/src/__tests__/routes/routes.test.ts`：

(a) 在模块顶部 helper 区（`resetDb` / `jsonReq` 同级，**不在 describe 块内**）加：

```ts
function submitBody(overrides: Record<string, unknown> = {}) {
  return {
    prompt: 'a cat',
    n: 1,
    device_id: 'test-device-aaaa-bbbb-cccc',
    client_request_id: crypto.randomUUID(),
    ...overrides,
  }
}
```

(b) 扩展 `resetDb()` 顺便清 daily_quota（避免配额测试互相干扰）：

```ts
async function resetDb() {
  await db.delete(schema.tasks)
  await db.delete(schema.daily_quota)
}
```

(c) 在 `describe('BFF queue routes', () => { ... })` 块**内部末尾**（最后一个 `it(...)` 之后、`})` 闭合之前）追加新 it 块：

```ts
  it('submit 缺失 device_id 返回 400', async () => {
    const { status } = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-1/submit',
      { prompt: 'a cat', n: 1 },
    )
    expect(status).toBe(400)
  })

  it('submit device_id 太短返回 400', async () => {
    const { status } = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-1/submit',
      submitBody({ device_id: 'short' }),
    )
    expect(status).toBe(400)
  })

  it('累计 5 次 n=10 后第 6 次返回 429 + daily_quota_exceeded', async () => {
    const device_id = 'quota-dev-aaaa-bbbb-cccc'
    for (let i = 0; i < 5; i++) {
      const { status } = await jsonReq(
        'POST',
        '/v1/queue/openai-compat/gpt-image-1/submit',
        submitBody({ device_id, n: 10, client_request_id: crypto.randomUUID() }),
      )
      expect(status).toBe(200)
    }
    const { status, json } = await jsonReq(
      'POST',
      '/v1/queue/openai-compat/gpt-image-1/submit',
      submitBody({ device_id, n: 1, client_request_id: crypto.randomUUID() }),
    )
    expect(status).toBe(429)
    expect(json).toMatchObject({
      error: 'daily_quota_exceeded',
      limit: 50,
      used: 50,
    })
    expect((json as { reset_at: string }).reset_at).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00/)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/bff && bun test src/__tests__/routes/routes.test.ts`
Expected: 新增 3 个用例 FAIL（device_id 缺失目前不会被 schema 拦下；超额逻辑还没接）。

- [ ] **Step 3: 改 submit.ts 加 device_id schema + quota gate**

修改 `apps/bff/src/routes/submit.ts`：

```ts
import type { QueueProvider } from '@image-playground/shared'
import { DAILY_QUOTA_LIMIT } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { tryConsumeQuota } from '../lib/quota'
import { spawnTask } from '../workers/task-runner'

const submitBodySchema = t.Object({
  prompt: t.String({ minLength: 1 }),
  size: t.Optional(t.String()),
  quality: t.Optional(t.String()),
  n: t.Optional(t.Number({ minimum: 1, maximum: 16 })),
  input_images: t.Optional(t.Array(t.String())),
  mask: t.Optional(t.String()),
  extra: t.Optional(t.Record(t.String(), t.Any())),
  client_request_id: t.Optional(t.String({ minLength: 8, maxLength: 64 })),
  /**
   * 浏览器持久化的设备 ID。BFF 用于按设备每日配额计数。前端 submitTask 时
   * 统一带；缺失或太短返回 400。BYOK profile 不走 BFF，无需此字段。
   */
  device_id: t.String({ minLength: 8, maxLength: 64 }),
})

function isQueueProvider(value: string): value is QueueProvider {
  return value === 'openai-compat' || value === 'gemini'
}

export const submitRoutes = new Elysia().post(
  '/v1/queue/:provider/:model/submit',
  async ({ params, body, status }) => {
    const { provider, model } = params
    if (!isQueueProvider(provider)) {
      return status(400, { error: `unsupported provider: ${provider}` })
    }

    // 幂等命中（client_request_id 已存在）走优先返回，避免重复扣配额。
    if (body.client_request_id) {
      const [existing] = await db
        .select({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })
        .from(schema.tasks)
        .where(eq(schema.tasks.client_request_id, body.client_request_id))
        .limit(1)
      if (existing) {
        return { request_id: existing.id, status: 'queued', submitted_at: existing.submitted_at }
      }
    }

    // 配额扣减：先扣后建。失败 → 429，不写 tasks。
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

    const id = crypto.randomUUID()
    const now = Date.now()
    const inserted = await db
      .insert(schema.tasks)
      .values({
        id,
        provider,
        model,
        status: 'queued',
        request_payload: body,
        submitted_at: now,
        client_request_id: body.client_request_id ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })

    if (inserted.length === 0 && body.client_request_id) {
      // 极端并发：上面 SELECT 没命中但 INSERT 冲突——重查兜底
      const [existing] = await db
        .select({ id: schema.tasks.id, submitted_at: schema.tasks.submitted_at })
        .from(schema.tasks)
        .where(eq(schema.tasks.client_request_id, body.client_request_id))
        .limit(1)
      if (existing)
        return { request_id: existing.id, status: 'queued', submitted_at: existing.submitted_at }
    }

    spawnTask(id, 'submit')

    return { request_id: id, status: 'queued', submitted_at: now }
  },
  {
    params: t.Object({
      provider: t.String(),
      model: t.String(),
    }),
    body: submitBodySchema,
  },
)
```

**关键改动说明**（不写进代码注释，但实施时心里有数）：

1. 把幂等命中检查**前置**到 quota gate 之前：刷新页面重提同一 client_request_id 不应该重复扣 50 张里的额度。
2. 原 INSERT-on-conflict-do-nothing 兜底保留，处理极端并发：同一 client_request_id 极短时间 2 次 submit，前置 SELECT 都没命中但 INSERT 冲突。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/bff && bun test src/__tests__/routes/routes.test.ts`
Expected: 所有用例 PASS（含新 3 个 + 旧有用例不退化）。

- [ ] **Step 5: 跑全量 BFF 测试**

Run: `cd apps/bff && pnpm test`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add apps/bff/src/routes/submit.ts apps/bff/src/__tests__/routes/routes.test.ts
git commit -m "feat(bff): submit 路由按 device_id 扣配额，超额返 429"
```

---

### Task 5: Web `deviceId.ts` helper

**Files:**
- Create: `apps/web/src/lib/deviceId.ts`
- Test: `apps/web/src/__tests__/lib/deviceId.test.ts`

- [ ] **Step 1: 写测试（先失败）**

新建 `apps/web/src/__tests__/lib/deviceId.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'image-playground.device_id'

describe('getDeviceId', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('首次调用：生成 UUID 写入 localStorage', async () => {
    const { getDeviceId } = await import('../../lib/deviceId')
    const id = getDeviceId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(id)
  })

  it('第二次调用：返回缓存的同一 ID', async () => {
    const { getDeviceId } = await import('../../lib/deviceId')
    const id1 = getDeviceId()
    const id2 = getDeviceId()
    expect(id2).toBe(id1)
  })

  it('已有 localStorage 值：直接复用', async () => {
    localStorage.setItem(STORAGE_KEY, 'existing-uuid-abcd-efgh')
    const { getDeviceId } = await import('../../lib/deviceId')
    expect(getDeviceId()).toBe('existing-uuid-abcd-efgh')
  })

  it('localStorage 中值过短：当作不存在，重新生成', async () => {
    localStorage.setItem(STORAGE_KEY, 'short')
    const { getDeviceId } = await import('../../lib/deviceId')
    const id = getDeviceId()
    expect(id).not.toBe('short')
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(id)
  })

  it('localStorage 抛错（隐私模式 / SSR）：fallback in-memory ID', async () => {
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })
    const getItemSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('SecurityError')
      })
    const { getDeviceId } = await import('../../lib/deviceId')
    const id = getDeviceId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
    // 同 session 内再调用应返同 ID
    expect(getDeviceId()).toBe(id)
    setItemSpy.mockRestore()
    getItemSpy.mockRestore()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && pnpm test src/__tests__/lib/deviceId.test.ts`
Expected: FAIL — `Cannot find module '../../lib/deviceId'`

- [ ] **Step 3: 写实现**

新建 `apps/web/src/lib/deviceId.ts`：

```ts
const STORAGE_KEY = 'image-playground.device_id'
let cached: string | null = null

/**
 * 返回浏览器持久化的匿名设备 ID。首次调用生成 UUID 写 localStorage；
 * 之后命中 in-memory 缓存。隐私模式 / SSR 等读写 localStorage 抛错时，
 * fallback 一个 in-memory ID（重启即新设备，可接受）。
 */
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
    if (!cached) cached = crypto.randomUUID()
    return cached
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && pnpm test src/__tests__/lib/deviceId.test.ts`
Expected: 5 个用例 PASS

注意：`cached` 是模块级状态，每个测试用例之间 `vi.resetModules()` 会重新 import 模块拿到全新的 `cached = null`，所以测试之间互相独立。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/deviceId.ts apps/web/src/__tests__/lib/deviceId.test.ts
git commit -m "feat(web): deviceId getter（localStorage + in-memory fallback）"
```

---

### Task 6: Web queueClient submit body + 429 错误处理

**Files:**
- Modify: `apps/web/src/lib/channels/queueClient.ts`
- Test: `apps/web/src/__tests__/lib/channels/queueClient.test.ts`（新建，目录已存在）

- [ ] **Step 1: 写测试（先失败）**

新建 `apps/web/src/__tests__/lib/channels/queueClient.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callQueueChannelApi } from '../../../lib/channels/queueClient'
import type { BuiltinEdgeProfile, PublicChannel } from '../../../lib/channels/types'

function mockChannel(): PublicChannel {
  return {
    id: 'test-queue',
    kind: 'openai-queue',
    label: 'test',
    bffBaseUrl: 'https://bff.example.com',
    provider: 'openai-compat',
    models: [{ id: 'gpt-image-1', label: 'GPT Image 1' }],
    defaultModel: 'gpt-image-1',
    defaults: {},
  } as unknown as PublicChannel
}

function mockProfile(): BuiltinEdgeProfile {
  return {
    selectedModelId: 'gpt-image-1',
  } as unknown as BuiltinEdgeProfile
}

function mockOpts() {
  return {
    prompt: 'a cat',
    params: { size: 'auto', quality: 'auto', n: 1 },
    inputImageDataUrls: [],
    maskDataUrl: undefined,
    clientRequestId: 'req-aaaa-bbbb-cccc',
  } as Parameters<typeof callQueueChannelApi>[0]
}

describe('callQueueChannelApi submit body', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('image-playground.device_id', 'dev-aaaa-bbbb-cccc')
  })
  afterEach(() => vi.restoreAllMocks())

  it('submit body 包含 device_id 字段', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    // 第 1 次请求：submit OK
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ request_id: 'rid-1', status: 'queued' }), { status: 200 }),
    )
    // 第 2 次请求（poll status）：直接 failed，让 callQueueChannelApi 立刻抛
    // 异常退出，不必等 30 分钟 POLL_MAX_MS 超时。
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            request_id: 'rid-1',
            status: 'failed',
            submitted_at: Date.now(),
            error: { message: 'test-stop', type: 'unknown' },
          }),
          { status: 200 },
        ),
    )

    await expect(
      callQueueChannelApi(mockOpts(), mockProfile(), mockChannel()),
    ).rejects.toThrow('test-stop')

    // 第一次请求即 submit，验证 body 含 device_id
    const firstCall = fetchSpy.mock.calls[0]!
    expect(String(firstCall[0])).toContain('/v1/queue/openai-compat/gpt-image-1/submit')
    const body = JSON.parse(String((firstCall[1] as RequestInit).body))
    expect(body.device_id).toBe('dev-aaaa-bbbb-cccc')
  })

  it('429 daily_quota_exceeded 抛中文错误且 quotaExceeded=true', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          error: 'daily_quota_exceeded',
          limit: 50,
          used: 50,
          reset_at: '2026-05-16T00:00:00.000Z',
        }),
        { status: 429 },
      )
    })

    try {
      await callQueueChannelApi(mockOpts(), mockProfile(), mockChannel())
      throw new Error('did not throw')
    } catch (err) {
      const e = err as Error & { quotaExceeded?: boolean; resetAt?: string }
      expect(e.message).toContain('今日 50 张已用完')
      expect(e.quotaExceeded).toBe(true)
      expect(e.resetAt).toBe('2026-05-16T00:00:00.000Z')
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/web && pnpm test src/__tests__/lib/channels/queueClient.test.ts`
Expected: FAIL — submit body 没 device_id；429 处理不抛中文错误。

- [ ] **Step 3: 改 queueClient.ts**

修改 `apps/web/src/lib/channels/queueClient.ts`：

(a) 顶部 import 区追加：

```ts
import { getDeviceId } from '../deviceId'
```

(b) 改 `submit()` 函数。在 `body` 对象构造段加 `device_id`：

```ts
  const body: Record<string, unknown> = {
    prompt: applyCodexCliPromptGuard(opts.prompt, codexCli),
    device_id: getDeviceId(),
  }
```

（把 `device_id: getDeviceId(),` 加到 `prompt:` 紧后面。）

(c) 改 `submit()` 函数的错误识别。原代码：

```ts
  if (!res.ok) {
    throw new Error(`BFF submit 失败：${await getApiErrorMessage(res)}`)
  }
```

改为：

```ts
  if (!res.ok) {
    if (res.status === 429) {
      const json = (await res.json().catch(() => null)) as
        | { error?: string; reset_at?: string }
        | null
      if (json?.error === 'daily_quota_exceeded') {
        const err = new Error('今日 50 张已用完，UTC 0 点（北京 8 点）后重置') as Error & {
          quotaExceeded: boolean
          resetAt?: string
        }
        err.quotaExceeded = true
        if (json.reset_at) err.resetAt = json.reset_at
        throw err
      }
    }
    throw new Error(`BFF submit 失败：${await getApiErrorMessage(res)}`)
  }
```

注意：`res.json()` 在错误响应上调用要 `.catch(() => null)`，避免 BFF 偶尔返非 JSON 错误页时整个流程卡死。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/web && pnpm test src/__tests__/lib/channels/queueClient.test.ts`
Expected: 2 个用例 PASS

- [ ] **Step 5: 跑全量 web 测试**

Run: `cd apps/web && pnpm test`
Expected: 全部通过（共 189+ 用例，加上新增的 2 个 + Task 5 的 5 个）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/channels/queueClient.ts apps/web/src/__tests__/lib/channels/queueClient.test.ts
git commit -m "feat(web): submit body 带 device_id + 429 配额超额抛中文错误"
```

---

### Task 7: 完整链路验证 + 手测

**Files:** 无新增

- [ ] **Step 1: 跑顶层全量 lint + typecheck + test**

Run: `pnpm exec biome check --write . && pnpm lint`
Expected: 0 errors（biome.json schema deprecation 的 warning/info 是已知 noise，忽略）

Run: `pnpm typecheck`
Expected: PASS

Run: `pnpm test`
Expected: 全 apps 全部通过

- [ ] **Step 2: 手测 dev 环境**

Run: `pnpm dev:web`（另起 terminal `cd apps/bff && pnpm dev` 起 BFF）

在浏览器：
1. 打开 dev 服务地址
2. 用内置 channel（不是 BYOK）发一张图，确认能生成成功
3. F12 → Network → submit 请求，确认 body 含 `device_id` 字段，值为 UUID
4. F12 → Application → Local Storage，确认 `image-playground.device_id` 已写入

- [ ] **Step 3: 手测配额超额（可选，破坏性，测完手动清表）**

不必跑到 50 张这么多。可以在 BFF 上手动把 daily_quota 改近 limit：

```sh
sqlite3 apps/bff/artifacts/image-playground.sqlite \
  "INSERT OR REPLACE INTO daily_quota (device_id, date, count) VALUES \
   ('<你的本地 device_id>', strftime('%Y-%m-%d','now'), 49);"
```

把 `<你的本地 device_id>` 换成 Local Storage 里的实际值。然后浏览器发一张 n=1 OK；再发一张应该会触发 429 + toast "今日 50 张已用完".

清理：

```sh
sqlite3 apps/bff/artifacts/image-playground.sqlite "DELETE FROM daily_quota;"
```

- [ ] **Step 4: 部署到 mac mini**

按 CLAUDE.md 的部署流程：

```sh
git push origin main
ssh macmini "cd /Users/qiqian/workspace/repos/qlj-image-playground && \
  git pull --rebase --autostash origin main && \
  pnpm deploy:local"
```

确认 `launchctl kickstart` 步骤无报错。

- [ ] **Step 5: 线上 smoke test**

打开线上 web 域名，发一张图确认成功；F12 → Network → submit 确认 body 含 device_id。

完工。

---

## Implementation Notes

### 关于已有用户（无 device_id 状态）

旧的浏览器 tab 刷新前 in-memory state 里没有 device_id，但 `getDeviceId()` 在 callQueueChannelApi → submit 调用时是首次调用，会立刻初始化并写入 localStorage。**无需迁移**。

### 部署顺序问题

spec §部署 / 迁移 提到："旧 client 不带 device_id → 新 BFF 拒"。`pnpm deploy:local` 把 web build + BFF 重启串成一个 launchctl kickstart 链。BFF 重启耗时约几百毫秒，期间所有 submit 失败的窗口很短，可接受。

### 失败 / 取消任务的退款

spec 明确：**不退款**。失败 / 取消任务保留 quota 消耗。后续要做退款再加（spec 范围外）。

### Monorepo workspace deps

`@image-playground/shared` 导入新常量 `DAILY_QUOTA_LIMIT`，BFF 和 web 都已经 import shared，零新增依赖。
