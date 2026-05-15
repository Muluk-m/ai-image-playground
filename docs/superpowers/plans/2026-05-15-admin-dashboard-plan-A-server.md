# Admin Dashboard Plan A — packages/db + admin server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 image-playground 加只读 admin API：把 BFF 现有 `apps/bff/src/db/` 迁到共享包 `packages/db/`，新建 `apps/admin/server/`（Elysia + Bun + Drizzle, 端口 37378），实现单密码鉴权 + 设备聚合查询 + 任务详情 + 图片反代。本 plan 完成后用 curl 即可完整验证 API；前端 UI 在 Plan B。

**Architecture:** packages/db 通过 `createDb(dbPath, { readonly })` 工厂统一暴露 Drizzle client，BFF/admin 各开独立 connection 但同文件（WAL 多进程安全）。admin server 100% 只读（`PRAGMA query_only=ON`），靠 HMAC 签名 cookie 守门，反代 BFF 的 binary 端点拿图字节，自身不 decode base64。

**Tech Stack:** Bun + Elysia + Drizzle + bun:sqlite + bun:test。零额外 npm 依赖（HMAC 用 Node/Bun 内置 `crypto.createHmac`）。

**Spec reference:** `docs/superpowers/specs/2026-05-15-admin-dashboard-design.md`

---

## File Structure

**Create**:
- `packages/db/package.json` — `@image-playground/db` workspace 包
- `packages/db/tsconfig.json` — 继承 base
- `packages/db/drizzle.config.ts` — drizzle-kit 配置
- `packages/db/src/index.ts` — 公开导出
- `packages/db/src/schema.ts` — 从 `apps/bff/src/db/schema.ts` 迁来
- `packages/db/src/migrate.ts` — 从 `apps/bff/src/db/migrate.ts` 迁来 + 加 device_id 列 + 索引
- `packages/db/src/client.ts` — 工厂 `createDb(dbPath, { readonly })`
- `packages/db/src/__tests__/client.test.ts` — readonly 模式验证
- `packages/db/src/__tests__/migrate.test.ts` — 从 `apps/bff/src/__tests__/lib/migrate.test.ts` 迁来 + 加 device_id 列断言
- `apps/admin/package.json`
- `apps/admin/tsconfig.json`
- `apps/admin/server/index.ts` — listen :37378
- `apps/admin/server/app.ts` — Elysia app 装配
- `apps/admin/server/config.ts` — env helper（同 BFF 风格）
- `apps/admin/server/lib/constants.ts` — SESSION_COOKIE_NAME 等
- `apps/admin/server/lib/session.ts` — HMAC sign/verify
- `apps/admin/server/lib/rate-limit.ts` — IP LRU
- `apps/admin/server/lib/middleware.ts` — requireAuth derive
- `apps/admin/server/lib/queries.ts` — 设备 / 任务 SQL 封装
- `apps/admin/server/lib/task-meta-cache.ts` — 图片端点 task meta 短 TTL LRU
- `apps/admin/server/routes/auth.ts` — /api/login /api/logout /api/me
- `apps/admin/server/routes/devices.ts` — /api/devices /api/devices/:id
- `apps/admin/server/routes/tasks.ts` — /api/tasks/:id
- `apps/admin/server/routes/images.ts` — /api/tasks/:id/image /api/tasks/:id/input-image
- `apps/admin/server/__tests__/lib/session.test.ts`
- `apps/admin/server/__tests__/lib/rate-limit.test.ts`
- `apps/admin/server/__tests__/lib/task-meta-cache.test.ts`
- `apps/admin/server/__tests__/lib/queries.test.ts`
- `apps/admin/server/__tests__/routes/auth.test.ts`
- `apps/admin/server/__tests__/routes/devices.test.ts`
- `apps/admin/server/__tests__/routes/tasks.test.ts`
- `apps/admin/server/__tests__/routes/images.test.ts`

**Modify**:
- `apps/bff/src/db/schema.ts` → re-export `@image-playground/db`
- `apps/bff/src/db/migrate.ts` → re-export `@image-playground/db`
- `apps/bff/src/db/client.ts` → re-export `@image-playground/db`，bff app 启动时调 `createDb` 拿单例
- `apps/bff/src/db/maintenance.ts` → 如有直接读 `process.env.DATABASE_URL` 处不动；引用 `db`/`schema` 路径不变
- `apps/bff/package.json` → 加 `@image-playground/db: workspace:*` 依赖
- `apps/bff/drizzle.config.ts` → 改 `schema` 路径到 `../../packages/db/src/schema.ts`，或直接删（迁到 packages/db）
- `apps/bff/src/__tests__/lib/migrate.test.ts` → **删除**（已迁到 packages/db）

**Won't change in this plan**:
- 任何前端 (`apps/web/`)
- `apps/bff/` 业务代码（routes/、workers/、lib/）—— 仅 db re-export

---

## Phase A: 共享包 packages/db

### Task 1: 新建 packages/db + 迁移 schema/migrate/client + BFF re-export

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/drizzle.config.ts`
- Create: `packages/db/src/index.ts`
- Create: `packages/db/src/schema.ts` (复制 + 加 daily_quota 已有)
- Create: `packages/db/src/migrate.ts` (复制)
- Create: `packages/db/src/client.ts` (复制)
- Create: `packages/db/src/__tests__/migrate.test.ts` (从 bff move 过来)
- Modify: `apps/bff/src/db/schema.ts` → re-export
- Modify: `apps/bff/src/db/migrate.ts` → re-export
- Modify: `apps/bff/src/db/client.ts` → re-export
- Modify: `apps/bff/package.json` → 加 workspace dep
- Modify: `apps/bff/drizzle.config.ts` → 改 schema 路径或删
- Delete: `apps/bff/src/__tests__/lib/migrate.test.ts`

- [ ] **Step 0: 建 packages/db 目录骨架**

```bash
mkdir -p packages/db/src/__tests__
```

- [ ] **Step 1: 新建 `packages/db/package.json`**

```json
{
  "name": "@image-playground/db",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test",
    "db:generate": "drizzle-kit generate"
  },
  "dependencies": {
    "drizzle-orm": "^0.45.2"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "drizzle-kit": "^0.31.10",
    "typescript": "^5.8.3"
  }
}
```

- [ ] **Step 2: 新建 `packages/db/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["bun"],
    "noEmit": true
  },
  "include": ["src/**/*", "drizzle.config.ts"]
}
```

- [ ] **Step 3: 新建 `packages/db/drizzle.config.ts`**

复制 `apps/bff/drizzle.config.ts` 的逻辑，但 schema 路径改成本地：

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '../../artifacts/image-playground.sqlite',
  },
})
```

- [ ] **Step 4: 复制 schema.ts**

```bash
cp apps/bff/src/db/schema.ts packages/db/src/schema.ts
```

确认 `packages/db/src/schema.ts` 内容跟 BFF 当前完全一致（含 tasks 表 + daily_quota 表 + Task 类型导出）。**不**做任何编辑。

- [ ] **Step 5: 复制 migrate.ts**

```bash
cp apps/bff/src/db/migrate.ts packages/db/src/migrate.ts
```

修改 `packages/db/src/migrate.ts`：删除底部 `config` import 和 `import.meta.main` 块（packages/db 不 own config），改成接受参数即可：

```ts
import { Database } from 'bun:sqlite'

/**
 * 直接执行建表 DDL，不依赖 drizzle-kit migrate runtime（避免 bun:sqlite 跟
 * better-sqlite3 migration runner 兼容性折腾）。schema 变更时用 drizzle-kit
 * generate 看 SQL 后手工同步到这里。
 */
const DDL_BASE = `
  CREATE TABLE IF NOT EXISTS tasks (
    id                 TEXT PRIMARY KEY,
    provider           TEXT NOT NULL,
    model              TEXT NOT NULL,
    status             TEXT NOT NULL,
    request_payload    TEXT NOT NULL,
    result_payload     TEXT,
    error_message      TEXT,
    error_type         TEXT,
    submitted_at       INTEGER NOT NULL,
    started_at         INTEGER,
    completed_at       INTEGER,
    client_request_id  TEXT
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

export function runMigrations(databaseUrl: string) {
  const sqlite = new Database(databaseUrl)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  sqlite.exec(DDL_BASE)
  // 老库兼容：CREATE TABLE IF NOT EXISTS 不会给已存在的表加新列。
  const cols = sqlite.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'client_request_id')) {
    sqlite.exec(`ALTER TABLE tasks ADD COLUMN client_request_id TEXT;`)
  }
  // partial unique 索引：NULL 不去重，老任务/未带 ID 的请求各自独立。
  sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_request_id
               ON tasks(client_request_id) WHERE client_request_id IS NOT NULL;`)
  sqlite.close()
}
```

注意：`runMigrations` 现在**必须**接 `databaseUrl` 参数（不再读 config，因为 packages/db 不 own config）。下面 BFF 改造时会传入。

- [ ] **Step 6: 复制 client.ts，但暂时保留原逻辑（下个 task 改成工厂）**

```bash
cp apps/bff/src/db/client.ts packages/db/src/client.ts
```

修改 `packages/db/src/client.ts`：删 `import { config }`，改成接受 `databaseUrl` 参数。临时简单版：

```ts
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from './schema'

/**
 * Drizzle client 工厂。Task 2 会扩展支持 readonly + WAL pragma 收敛。
 * 当前仅 wrap Database 暴露 `db` + `schema` + `checkpointWal`。
 */
export function createDb(databaseUrl: string) {
  const sqlite = new Database(databaseUrl)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  const db = drizzle(sqlite, { schema })
  const checkpointWal = () => {
    try {
      sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {
      /* ignore */
    }
  }
  return { db, schema, checkpointWal, sqlite }
}

export { schema }
```

- [ ] **Step 7: 新建 `packages/db/src/index.ts`**

```ts
export * from './schema'
export { createDb } from './client'
export { runMigrations } from './migrate'
```

- [ ] **Step 8: 把 bff 那份 migrate test 迁过来**

```bash
mv apps/bff/src/__tests__/lib/migrate.test.ts packages/db/src/__tests__/migrate.test.ts
```

修改 `packages/db/src/__tests__/migrate.test.ts`，把 import 路径从 `'../../db/migrate'` 改成 `'../migrate'`：

```ts
import { describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { unlinkSync } from 'node:fs'

const TEST_DB = './artifacts/test-migrate.sqlite'

describe('runMigrations', () => {
  it('creates daily_quota table with correct columns + primary key', () => {
    try {
      unlinkSync(TEST_DB)
      unlinkSync(`${TEST_DB}-wal`)
      unlinkSync(`${TEST_DB}-shm`)
    } catch {}

    // 用 dynamic import 跟原 test 风格一致避免 env 共享 process 污染
    const { runMigrations } = require('../migrate') as typeof import('../migrate')
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

注意：原 test 用 `process.env.DATABASE_URL = TEST_DB` + dynamic await import 防止 env 共享污染。`packages/db` 不读 env，直接传参，所以**不再需要 env injection**——直接 `require` 即可。

- [ ] **Step 9: BFF re-export — 改 schema/migrate/client**

修改 `apps/bff/src/db/schema.ts`，整个文件替换为：

```ts
export { tasks, daily_quota } from '@image-playground/db'
export type { Task, NewTask } from '@image-playground/db'
```

修改 `apps/bff/src/db/migrate.ts`，整个文件替换为：

```ts
import { runMigrations as runMigrationsBase } from '@image-playground/db'
import { config } from '../config'

export function runMigrations(databaseUrl: string = config.databaseUrl) {
  return runMigrationsBase(databaseUrl)
}

if (import.meta.main) {
  runMigrations()
  console.log(`✓ migrations applied to ${config.databaseUrl}`)
}
```

修改 `apps/bff/src/db/client.ts`，整个文件替换为：

```ts
import { createDb } from '@image-playground/db'
import { config } from '../config'

const { db, schema, checkpointWal } = createDb(config.databaseUrl)

export { db, schema, checkpointWal }
```

- [ ] **Step 10: 改 BFF package.json 加 workspace dep**

修改 `apps/bff/package.json`，在 `dependencies` 块加：

```json
    "@image-playground/db": "workspace:*",
```

完整 dependencies 块应为：

```json
  "dependencies": {
    "@elysiajs/cors": "^1.4.0",
    "@image-playground/db": "workspace:*",
    "@image-playground/shared": "workspace:*",
    "drizzle-orm": "^0.45.2",
    "elysia": "^1.4.0",
    "pino": "^10.3.1"
  },
```

- [ ] **Step 11: BFF drizzle.config.ts 改 schema 路径**

修改 `apps/bff/drizzle.config.ts`，把 schema 指到 packages/db：

```ts
import { defineConfig } from 'drizzle-kit'
import { config } from './src/config'

export default defineConfig({
  dialect: 'sqlite',
  schema: '../../packages/db/src/schema.ts',
  out: './drizzle/migrations',
  dbCredentials: { url: config.databaseUrl },
})
```

- [ ] **Step 12: 安装 deps 并验证编译**

Run: `pnpm install`
Expected: workspace 解析 `@image-playground/db` 成功，无错误。

Run: `pnpm typecheck`
Expected: 全 3 packages PASS（shared + db + bff）

如果报 `Cannot find module '@image-playground/db/schema'`，可能 exports map 配置问题——回 Step 1 检查 `packages/db/package.json` 的 `exports` 字段。

- [ ] **Step 13: 跑全 BFF 测试**

Run: `pnpm test`
Expected: BFF 27/27 + packages/db migrate 1/1 + web 196/196 全过

- [ ] **Step 14: Commit**

```bash
git add packages/db apps/bff/src/db apps/bff/package.json apps/bff/drizzle.config.ts pnpm-lock.yaml
git rm apps/bff/src/__tests__/lib/migrate.test.ts
git commit -m "refactor: 抽 packages/db 共享 BFF + admin DB schema/migrate/client"
```

---

### Task 2: createDb 工厂 — readonly mode + WAL 收敛

**Files:**
- Modify: `packages/db/src/client.ts`
- Modify: `packages/db/src/index.ts`
- Create: `packages/db/src/__tests__/client.test.ts`

- [ ] **Step 1: 写测试（先失败）**

新建 `packages/db/src/__tests__/client.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'
import { unlinkSync } from 'node:fs'
import { createDb } from '../client'
import { runMigrations } from '../migrate'

const TEST_DB = './artifacts/test-client.sqlite'

describe('createDb', () => {
  it('default mode 可读写 tasks 表', () => {
    try {
      unlinkSync(TEST_DB)
      unlinkSync(`${TEST_DB}-wal`)
      unlinkSync(`${TEST_DB}-shm`)
    } catch {}
    runMigrations(TEST_DB)

    const { db, schema } = createDb(TEST_DB)
    // 直接 insert 应成功
    const inserted = db
      .insert(schema.tasks)
      .values({
        id: 'test-rw',
        provider: 'openai-compat',
        model: 'm',
        status: 'queued',
        request_payload: { prompt: 'x', device_id: 'd-aaaaaaaa' } as never,
        submitted_at: Date.now(),
      })
      .run()
    expect(inserted.changes).toBe(1)
  })

  it('readonly mode 拒绝 INSERT（PRAGMA query_only=ON）', () => {
    try {
      unlinkSync(TEST_DB)
      unlinkSync(`${TEST_DB}-wal`)
      unlinkSync(`${TEST_DB}-shm`)
    } catch {}
    runMigrations(TEST_DB)

    const { db, schema } = createDb(TEST_DB, { readonly: true })
    expect(() =>
      db
        .insert(schema.tasks)
        .values({
          id: 'test-ro',
          provider: 'openai-compat',
          model: 'm',
          status: 'queued',
          request_payload: { prompt: 'x', device_id: 'd-aaaaaaaa' } as never,
          submitted_at: Date.now(),
        })
        .run(),
    ).toThrow(/readonly|read.?only|attempt to write/i)
  })

  it('readonly mode 仍允许 SELECT', () => {
    try {
      unlinkSync(TEST_DB)
      unlinkSync(`${TEST_DB}-wal`)
      unlinkSync(`${TEST_DB}-shm`)
    } catch {}
    runMigrations(TEST_DB)

    // 先用 rw 写一条
    const rw = createDb(TEST_DB)
    rw.db
      .insert(rw.schema.tasks)
      .values({
        id: 'seed',
        provider: 'openai-compat',
        model: 'm',
        status: 'completed',
        request_payload: { prompt: 'x', device_id: 'd-aaaaaaaa' } as never,
        submitted_at: Date.now(),
      })
      .run()

    const { db, schema } = createDb(TEST_DB, { readonly: true })
    const rows = db.select().from(schema.tasks).all()
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/db && bun test src/__tests__/client.test.ts`
Expected: FAIL — `createDb` 第二参 `{readonly}` 当前 signature 不接，行为也没区分 ro。

- [ ] **Step 3: 改造 createDb 加 readonly**

修改 `packages/db/src/client.ts`：

```ts
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import * as schema from './schema'

export interface CreateDbOptions {
  /** 设 true 时打开 PRAGMA query_only=ON，所有 INSERT/UPDATE/DELETE 抛错。 */
  readonly?: boolean
}

/**
 * Drizzle client 工厂。
 * - 任何模式都开 WAL（多进程读 + 单进程写安全）
 * - readonly 模式额外 query_only=ON，admin 进程用此模式确保不会误写
 */
export function createDb(databaseUrl: string, options: CreateDbOptions = {}) {
  const sqlite = new Database(databaseUrl)
  sqlite.exec('PRAGMA journal_mode = WAL;')
  if (options.readonly) {
    sqlite.exec('PRAGMA query_only = ON;')
  }
  const db = drizzle(sqlite, { schema })
  const checkpointWal = () => {
    try {
      sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    } catch {
      /* ignore */
    }
  }
  return { db, schema, checkpointWal, sqlite }
}

export { schema }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/db && bun test src/__tests__/client.test.ts`
Expected: 3 个测试 PASS

如果 readonly INSERT 没抛错（PRAGMA query_only 在 bun:sqlite 不生效）—— STOP，escalate。可能要换用 `Database.open(..., { readonly: true })` 而非 PRAGMA。

- [ ] **Step 5: 全 packages/db 测试**

Run: `cd packages/db && pnpm test`
Expected: client.test 3 + migrate.test 1 = 4 pass

- [ ] **Step 6: 全 BFF 测试**

Run: `cd apps/bff && pnpm test`
Expected: 27/27 pass

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/client.ts packages/db/src/__tests__/client.test.ts
git commit -m "feat(db): createDb 加 readonly 模式（PRAGMA query_only）"
```

---

### Task 3: device_id VIRTUAL 列 + 索引

**Files:**
- Modify: `packages/db/src/migrate.ts`
- Modify: `packages/db/src/__tests__/migrate.test.ts` (加新断言)

- [ ] **Step 1: 改测试加 device_id 列断言（先失败）**

修改 `packages/db/src/__tests__/migrate.test.ts`，加新 `it` 块：

```ts
  it('tasks 表有 device_id 生成列 + idx_tasks_device_id 索引', () => {
    try {
      unlinkSync(TEST_DB)
      unlinkSync(`${TEST_DB}-wal`)
      unlinkSync(`${TEST_DB}-shm`)
    } catch {}

    const { runMigrations } = require('../migrate') as typeof import('../migrate')
    runMigrations(TEST_DB)

    const sqlite = new Database(TEST_DB)

    // device_id 列存在
    const taskCols = sqlite.query('PRAGMA table_info(tasks)').all() as Array<{
      name: string
    }>
    expect(taskCols.some((c) => c.name === 'device_id')).toBe(true)

    // 索引存在
    const indexes = sqlite
      .query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tasks'")
      .all() as Array<{ name: string }>
    expect(indexes.some((i) => i.name === 'idx_tasks_device_id')).toBe(true)

    // 验证生成列实际工作：插入一条带 device_id 的 task，json_extract 应抽出
    sqlite.exec(`
      INSERT INTO tasks (id, provider, model, status, request_payload, submitted_at)
      VALUES ('t1', 'openai-compat', 'm', 'queued',
              '{"prompt":"x","device_id":"dev-aaaaaaaa"}', ${Date.now()})
    `)
    const row = sqlite
      .query("SELECT device_id FROM tasks WHERE id='t1'")
      .get() as { device_id: string | null }
    expect(row.device_id).toBe('dev-aaaaaaaa')

    sqlite.close()
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/db && bun test src/__tests__/migrate.test.ts`
Expected: 新 `it` FAIL — `device_id` 列不存在；索引不存在。

- [ ] **Step 3: 加 migration**

修改 `packages/db/src/migrate.ts`，在 `runMigrations` 函数末尾（`sqlite.close()` 之前）加：

```ts
  // device_id VIRTUAL 列：admin 设备聚合 GROUP BY 需要索引，但 device_id 实际存
  // 在 request_payload JSON 里。生成列 VIRTUAL 不占额外空间，索引让聚合 < 10ms。
  // 老库兼容：PRAGMA table_info 查询确认列存在与否，不存在才 ALTER。
  const cols2 = sqlite.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
  if (!cols2.some((c) => c.name === 'device_id')) {
    sqlite.exec(`
      ALTER TABLE tasks ADD COLUMN device_id TEXT
        GENERATED ALWAYS AS (json_extract(request_payload, '$.device_id')) VIRTUAL;
    `)
  }
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_device_id ON tasks(device_id);`)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/db && bun test src/__tests__/migrate.test.ts`
Expected: 2 个 `it` 都 PASS

- [ ] **Step 5: 全测试 + typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: 全包全过

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/migrate.ts packages/db/src/__tests__/migrate.test.ts
git commit -m "feat(db): tasks 加 device_id 生成列 + idx_tasks_device_id 索引"
```

---

## Phase B: Admin server 骨架 + 鉴权

### Task 4: apps/admin 骨架 + Elysia /health

**Files:**
- Create: `apps/admin/package.json`
- Create: `apps/admin/tsconfig.json`
- Create: `apps/admin/server/config.ts`
- Create: `apps/admin/server/app.ts`
- Create: `apps/admin/server/index.ts`
- Create: `apps/admin/server/__tests__/routes/health.test.ts`

- [ ] **Step 1: 写测试（先失败）**

新建 `apps/admin/server/__tests__/routes/health.test.ts`：

```ts
import { describe, expect, it } from 'bun:test'

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.BFF_INTERNAL_URL = 'http://localhost:9999'
process.env.DATABASE_URL = './artifacts/test-admin-health.sqlite'
process.env.PORT = '0'

const { app } = await import('../../app')

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await app.handle(new Request('http://localhost/health'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/admin && bun test`
Expected: FAIL — `Cannot find module '../../app'`

- [ ] **Step 3: 新建 package.json**

`apps/admin/package.json`:

```json
{
  "name": "@image-playground/admin",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "server/index.ts",
  "scripts": {
    "dev:server": "bun run --watch server/index.ts",
    "start": "bun run server/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "bun test"
  },
  "dependencies": {
    "@elysiajs/cors": "^1.4.0",
    "@image-playground/db": "workspace:*",
    "@image-playground/shared": "workspace:*",
    "drizzle-orm": "^0.45.2",
    "elysia": "^1.4.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.8.3"
  }
}
```

- [ ] **Step 4: 新建 tsconfig.json**

`apps/admin/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["bun"],
    "noEmit": true
  },
  "include": ["server/**/*"]
}
```

- [ ] **Step 5: 新建 config.ts**

`apps/admin/server/config.ts`:

```ts
const env = (key: string, fallback?: string): string => {
  const v = process.env[key]
  if (v && v.trim()) return v.trim()
  if (fallback !== undefined) return fallback
  throw new Error(`Missing env: ${key}`)
}

const cookieSecret = env('ADMIN_COOKIE_SECRET')
if (cookieSecret.length < 32) {
  throw new Error('ADMIN_COOKIE_SECRET must be at least 32 chars')
}

export const config = {
  port: Number(env('PORT', '37378')),
  adminPassword: env('ADMIN_PASSWORD'),
  cookieSecret,
  bffInternalUrl: env('BFF_INTERNAL_URL', 'http://127.0.0.1:37377').replace(/\/+$/, ''),
  databaseUrl: env('DATABASE_URL', '../../artifacts/image-playground.sqlite'),
  corsOrigins: env('CORS_ALLOWED_ORIGINS', '*'),
}
```

- [ ] **Step 6: 新建 app.ts**

`apps/admin/server/app.ts`:

```ts
import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'
import { config } from './config'

const corsOrigin =
  config.corsOrigins === '*'
    ? true
    : config.corsOrigins.split(',').map((s) => s.trim()).filter(Boolean)

export const app = new Elysia()
  .use(cors({ origin: corsOrigin, credentials: true }))
  .get('/health', () => ({ ok: true }))
```

- [ ] **Step 7: 新建 index.ts**

`apps/admin/server/index.ts`:

```ts
import { app } from './app'
import { config } from './config'

app.listen(config.port)
console.log(`✓ admin server listening on http://localhost:${config.port}`)
```

- [ ] **Step 8: pnpm install + typecheck + test**

```bash
pnpm install
pnpm typecheck
cd apps/admin && bun test
```

Expected: install OK，typecheck OK，1 个 health test PASS。

- [ ] **Step 9: Commit**

```bash
git add apps/admin pnpm-lock.yaml
git commit -m "feat(admin): server 骨架（Elysia + Bun + /health）"
```

---

### Task 5: 鉴权 — session lib + middleware + rate-limit + auth routes

**Files:**
- Create: `apps/admin/server/lib/constants.ts`
- Create: `apps/admin/server/lib/session.ts`
- Create: `apps/admin/server/lib/rate-limit.ts`
- Create: `apps/admin/server/lib/middleware.ts`
- Create: `apps/admin/server/routes/auth.ts`
- Create: `apps/admin/server/__tests__/lib/session.test.ts`
- Create: `apps/admin/server/__tests__/lib/rate-limit.test.ts`
- Create: `apps/admin/server/__tests__/routes/auth.test.ts`
- Modify: `apps/admin/server/app.ts` (use authRoutes)

- [ ] **Step 1: 写 session 测试（先失败）**

`apps/admin/server/__tests__/lib/session.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = './artifacts/test-admin-session.sqlite'
process.env.PORT = '0'

const { signSession, verifySession } = await import('../../lib/session')

describe('signSession / verifySession', () => {
  it('签发的 cookie 立即能验证', () => {
    const cookie = signSession()
    const { valid, expiresAt } = verifySession(cookie)
    expect(valid).toBe(true)
    expect(expiresAt).toBeInstanceOf(Date)
    expect(expiresAt!.getTime()).toBeGreaterThan(Date.now())
  })

  it('过期的 cookie 验证失败', () => {
    // ttl = -1ms 表示立即过期
    const cookie = signSession(-1)
    const { valid } = verifySession(cookie)
    expect(valid).toBe(false)
  })

  it('篡改 expires_at 验证失败', () => {
    const cookie = signSession()
    const [_iso, hmac] = cookie.split('.')
    const tampered = `2099-01-01T00:00:00.000Z.${hmac}`
    const { valid } = verifySession(tampered)
    expect(valid).toBe(false)
  })

  it('篡改 hmac 验证失败', () => {
    const cookie = signSession()
    const [iso] = cookie.split('.')
    const tampered = `${iso}.evil-hmac-aaaaaa`
    const { valid } = verifySession(tampered)
    expect(valid).toBe(false)
  })

  it('空字符串 / 格式错误验证失败', () => {
    expect(verifySession('').valid).toBe(false)
    expect(verifySession('no-dot').valid).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/admin && bun test src/__tests__/lib/session.test.ts`
注意路径——文件在 `server/__tests__/lib/session.test.ts`：

Run: `cd apps/admin && bun test server/__tests__/lib/session.test.ts`
Expected: FAIL — `Cannot find module '../../lib/session'`

- [ ] **Step 3: 写 constants.ts**

`apps/admin/server/lib/constants.ts`:

```ts
export const SESSION_COOKIE_NAME = 'admin_session'
/** Session TTL 7 天 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
```

- [ ] **Step 4: 写 session.ts**

`apps/admin/server/lib/session.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config'
import { SESSION_TTL_MS } from './constants'

/**
 * Cookie 格式：`<expires_at_iso>.<hmac-sha256-base64url>`
 * HMAC 输入是 expires_at_iso 文本，secret 来自 ADMIN_COOKIE_SECRET env。
 * 零持久化：cookie 自带过期时间 + 签名，admin server 重启不丢登录。
 */

export function signSession(ttlMs: number = SESSION_TTL_MS): string {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString()
  const hmac = createHmac('sha256', config.cookieSecret).update(expiresAt).digest('base64url')
  return `${expiresAt}.${hmac}`
}

export function verifySession(cookieVal: string): {
  valid: boolean
  expiresAt?: Date
} {
  if (!cookieVal || !cookieVal.includes('.')) return { valid: false }
  const dotIdx = cookieVal.indexOf('.')
  const iso = cookieVal.slice(0, dotIdx)
  const providedHmac = cookieVal.slice(dotIdx + 1)
  const expectedHmac = createHmac('sha256', config.cookieSecret).update(iso).digest('base64url')

  // timingSafeEqual 要求两 buffer 等长，否则直接失败
  if (providedHmac.length !== expectedHmac.length) return { valid: false }
  const eq = timingSafeEqual(Buffer.from(providedHmac), Buffer.from(expectedHmac))
  if (!eq) return { valid: false }

  const expiresAt = new Date(iso)
  if (Number.isNaN(expiresAt.getTime())) return { valid: false }
  if (expiresAt.getTime() < Date.now()) return { valid: false }

  return { valid: true, expiresAt }
}
```

- [ ] **Step 5: 跑 session 测试确认通过**

Run: `cd apps/admin && bun test server/__tests__/lib/session.test.ts`
Expected: 5 个用例 PASS

- [ ] **Step 6: 写 rate-limit 测试（先失败）**

`apps/admin/server/__tests__/lib/rate-limit.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'bun:test'

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = './artifacts/test-admin-rl.sqlite'
process.env.PORT = '0'

const { createRateLimiter } = await import('../../lib/rate-limit')

describe('createRateLimiter', () => {
  it('前 5 次失败不锁；第 6 次 returnLocked', () => {
    const rl = createRateLimiter({ maxFailures: 5, windowMs: 60_000, lockMs: 600_000 })
    for (let i = 0; i < 5; i++) {
      expect(rl.recordFailure('1.1.1.1')).toBe(false)
    }
    expect(rl.recordFailure('1.1.1.1')).toBe(true) // 第 6 次锁
    expect(rl.isLocked('1.1.1.1')).toBe(true)
  })

  it('成功时 reset 失败计数', () => {
    const rl = createRateLimiter({ maxFailures: 5, windowMs: 60_000, lockMs: 600_000 })
    for (let i = 0; i < 4; i++) rl.recordFailure('2.2.2.2')
    rl.recordSuccess('2.2.2.2')
    // 重新累计也要 5 次才锁
    for (let i = 0; i < 5; i++) {
      expect(rl.recordFailure('2.2.2.2')).toBe(false)
    }
    expect(rl.recordFailure('2.2.2.2')).toBe(true)
  })

  it('不同 IP 各自独立', () => {
    const rl = createRateLimiter({ maxFailures: 5, windowMs: 60_000, lockMs: 600_000 })
    for (let i = 0; i < 5; i++) rl.recordFailure('3.3.3.3')
    rl.recordFailure('3.3.3.3') // 锁 3.3.3.3
    expect(rl.isLocked('4.4.4.4')).toBe(false)
  })

  it('LRU 容量上限 1024：超出时淘汰最老', () => {
    const rl = createRateLimiter({ maxFailures: 5, windowMs: 60_000, lockMs: 600_000, maxEntries: 3 })
    rl.recordFailure('ip-a')
    rl.recordFailure('ip-b')
    rl.recordFailure('ip-c')
    rl.recordFailure('ip-d') // 应淘汰 ip-a
    // ip-a 重新出现：失败计数应该重置（之前的状态被淘汰了）
    for (let i = 0; i < 5; i++) {
      expect(rl.recordFailure('ip-a')).toBe(false)
    }
  })
})
```

- [ ] **Step 7: 跑 rate-limit 测试确认失败**

Run: `cd apps/admin && bun test server/__tests__/lib/rate-limit.test.ts`
Expected: FAIL — module not found

- [ ] **Step 8: 写 rate-limit.ts**

`apps/admin/server/lib/rate-limit.ts`:

```ts
/**
 * 内存 LRU rate limiter。键 = IP 字符串。
 * - maxFailures 次失败 → recordFailure 返 true 表示需要锁定
 * - 锁定期间 isLocked 持续 true
 * - 成功调用 recordSuccess 清空失败计数（保持 unlocked）
 * - maxEntries 满后淘汰最久未访问的 IP（防内存无界增长）
 *
 * 单实例（admin 进程内），进程重启清空 — 自用场景可接受。
 */

interface Entry {
  failures: number
  /** 失败窗口起点（Date.now()）；超过 windowMs 重置 failures */
  windowStart: number
  /** 锁定到此时间戳（Date.now()）；< now 视为未锁 */
  lockedUntil: number
}

export interface RateLimiterOptions {
  maxFailures: number
  windowMs: number
  lockMs: number
  /** 默认 1024 */
  maxEntries?: number
}

export interface RateLimiter {
  /** 记一次失败。返回是否进入锁定（即刚刚到第 maxFailures+1 次）。 */
  recordFailure(key: string): boolean
  /** 记一次成功；清失败计数（不解锁——锁了就锁了，等 lockMs 过） */
  recordSuccess(key: string): void
  isLocked(key: string): boolean
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const maxEntries = opts.maxEntries ?? 1024
  // Map 在 JS 中保留插入顺序，删除再插入 = 移到末尾，天然 LRU
  const entries = new Map<string, Entry>()

  function touch(key: string, entry: Entry) {
    entries.delete(key)
    entries.set(key, entry)
    // 淘汰最老的（Map 第一个）
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  return {
    recordFailure(key) {
      const now = Date.now()
      let entry = entries.get(key)
      if (!entry || now - entry.windowStart > opts.windowMs) {
        entry = { failures: 0, windowStart: now, lockedUntil: 0 }
      }
      entry.failures += 1
      const justLocked = entry.failures > opts.maxFailures
      if (justLocked) {
        entry.lockedUntil = now + opts.lockMs
      }
      touch(key, entry)
      return justLocked
    },
    recordSuccess(key) {
      const entry = entries.get(key)
      if (!entry) return
      entry.failures = 0
      entry.windowStart = Date.now()
      touch(key, entry)
    },
    isLocked(key) {
      const entry = entries.get(key)
      if (!entry) return false
      return entry.lockedUntil > Date.now()
    },
  }
}
```

- [ ] **Step 9: 跑 rate-limit 测试确认通过**

Run: `cd apps/admin && bun test server/__tests__/lib/rate-limit.test.ts`
Expected: 4 个用例 PASS

- [ ] **Step 10: 写 middleware.ts**

`apps/admin/server/lib/middleware.ts`:

```ts
import { Elysia } from 'elysia'
import { SESSION_COOKIE_NAME } from './constants'
import { verifySession } from './session'

/**
 * Elysia derive：从 cookie 校验 admin session。401 抛错 by setting status，路由
 * handler 通过 derive 出来的 `admin` 字段判断。挂在 protected routes 上。
 */
export const requireAuth = new Elysia({ name: 'requireAuth' }).derive(
  { as: 'scoped' },
  ({ cookie, set }) => {
    const cookieVal = cookie[SESSION_COOKIE_NAME]?.value
    const { valid } = verifySession(cookieVal ?? '')
    if (!valid) {
      set.status = 401
      throw new Error('unauthorized')
    }
    return { admin: true as const }
  },
)
```

- [ ] **Step 11: 写 auth 路由测试（先失败）**

`apps/admin/server/__tests__/routes/auth.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'

process.env.ADMIN_PASSWORD = 'correct-horse-battery-staple'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = './artifacts/test-admin-auth.sqlite'
process.env.BFF_INTERNAL_URL = 'http://localhost:9999'
process.env.PORT = '0'

const { app } = await import('../../app')

async function post(path: string, body?: unknown, cookieHeader?: string) {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookieHeader) headers.cookie = cookieHeader
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

async function get(path: string, cookieHeader?: string) {
  const headers: Record<string, string> = {}
  if (cookieHeader) headers.cookie = cookieHeader
  return app.handle(new Request(`http://localhost${path}`, { headers }))
}

describe('POST /api/login', () => {
  it('正确密码 → 200 + Set-Cookie', async () => {
    const res = await post('/api/login', { password: 'correct-horse-battery-staple' })
    expect(res.status).toBe(200)
    const cookieHeader = res.headers.get('set-cookie') ?? ''
    expect(cookieHeader).toContain('admin_session=')
    expect(cookieHeader).toContain('HttpOnly')
    expect(cookieHeader).toContain('SameSite=Lax')
  })

  it('错误密码 → 401', async () => {
    const res = await post('/api/login', { password: 'wrong' })
    expect(res.status).toBe(401)
    const json = (await res.json()) as { error: string }
    expect(json.error).toBe('invalid_password')
  })

  it('5 次连续失败后第 6 次 → 429 locked', async () => {
    // routes/auth.ts module 顶层 limiter 在 bun:test 同文件内是 singleton，前面
    // "错误密码" 测试可能已经累积了 fails。用一次 success login 把 failures 重置 0。
    const reset = await post('/api/login', { password: 'correct-horse-battery-staple' })
    expect(reset.status).toBe(200)
    // 5 次错：fails 1..5，都 ≤ maxFailures=5，所以全 401
    for (let i = 0; i < 5; i++) {
      const res = await post('/api/login', { password: 'wrong' })
      expect(res.status).toBe(401)
    }
    // 第 6 次错：fails=6，justLocked=true → 429
    const res6 = await post('/api/login', { password: 'wrong' })
    expect(res6.status).toBe(429)
  })
})

describe('POST /api/logout', () => {
  it('清 cookie', async () => {
    // 先 login
    const loginRes = await post('/api/login', { password: 'correct-horse-battery-staple' })
    const cookieRaw = loginRes.headers.get('set-cookie')!
    const sessionCookie = cookieRaw.split(';')[0]!
    const logoutRes = await post('/api/logout', undefined, sessionCookie)
    expect(logoutRes.status).toBe(200)
    const clearHeader = logoutRes.headers.get('set-cookie') ?? ''
    // 清 cookie 一般是 Max-Age=0 或过期时间在过去
    expect(clearHeader).toContain('admin_session=')
    expect(/(Max-Age=0|Expires=)/i.test(clearHeader)).toBe(true)
  })
})

describe('GET /api/me', () => {
  it('未登录 → 401', async () => {
    const res = await get('/api/me')
    expect(res.status).toBe(401)
  })

  it('登录后 → 200 ok', async () => {
    const loginRes = await post('/api/login', { password: 'correct-horse-battery-staple' })
    const sessionCookie = loginRes.headers.get('set-cookie')!.split(';')[0]!
    const meRes = await get('/api/me', sessionCookie)
    expect(meRes.status).toBe(200)
    const body = (await meRes.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})
```

注意：bun:test 共享 process 时 rate limiter 状态会跨 it 累积。auth.test.ts 内"5 次连续失败后第 6 次锁"测试必须**最后**跑，或者每个 it 之间 reset rate limiter。

为隔离测试，admin app 应该暴露一个 reset hook 给测试用。但更简单：让 rate limit 测试**与 login 成功 / logout 测试分文件**，或在 auth.test.ts 里跑 lock 测试**最后一个**，其它先跑。

bun:test 按文件内顺序执行，把"5 次锁"用例放最后即可。

- [ ] **Step 12: 跑 auth 测试确认失败**

Run: `cd apps/admin && bun test server/__tests__/routes/auth.test.ts`
Expected: FAIL — auth routes 未实现，所有用例 fail。

- [ ] **Step 13: 写 routes/auth.ts**

`apps/admin/server/routes/auth.ts`:

```ts
import { timingSafeEqual } from 'node:crypto'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from '../lib/constants'
import { requireAuth } from '../lib/middleware'
import { createRateLimiter } from '../lib/rate-limit'
import { signSession } from '../lib/session'

const limiter = createRateLimiter({
  maxFailures: 5,
  windowMs: 60_000,
  lockMs: 10 * 60_000,
  maxEntries: 1024,
})

function clientKey(request: Request): string {
  // Cloudflare tunnel 把客户端 IP 放 CF-Connecting-IP；标准 X-Forwarded-For
  // 取首段；都没就用 'unknown'（测试 / 本机 dev）
  const cf = request.headers.get('cf-connecting-ip')
  if (cf) return cf
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  return 'unknown'
}

function eqPassword(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export const authRoutes = new Elysia()
  .post(
    '/api/login',
    ({ body, cookie, request, set }) => {
      const key = clientKey(request)
      if (limiter.isLocked(key)) {
        set.status = 429
        return { error: 'rate_limited' }
      }
      if (!eqPassword(body.password, config.adminPassword)) {
        const locked = limiter.recordFailure(key)
        set.status = locked ? 429 : 401
        return { error: locked ? 'rate_limited' : 'invalid_password' }
      }
      limiter.recordSuccess(key)

      const value = signSession()
      cookie[SESSION_COOKIE_NAME].set({
        value,
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_TTL_MS / 1000,
      })
      return { ok: true }
    },
    {
      body: t.Object({
        password: t.String({ minLength: 1, maxLength: 256 }),
      }),
    },
  )
  .use(requireAuth)
  .post('/api/logout', ({ cookie }) => {
    cookie[SESSION_COOKIE_NAME].set({
      value: '',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    })
    return { ok: true }
  })
  .get('/api/me', () => ({ ok: true }))
```

- [ ] **Step 14: 改 app.ts use authRoutes**

修改 `apps/admin/server/app.ts`：

```ts
import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'
import { config } from './config'
import { authRoutes } from './routes/auth'

const corsOrigin =
  config.corsOrigins === '*'
    ? true
    : config.corsOrigins.split(',').map((s) => s.trim()).filter(Boolean)

export const app = new Elysia()
  .use(cors({ origin: corsOrigin, credentials: true }))
  .get('/health', () => ({ ok: true }))
  .use(authRoutes)
```

- [ ] **Step 15: 跑 auth 测试确认通过**

Run: `cd apps/admin && bun test server/__tests__/routes/auth.test.ts`
Expected: 全 5 个用例 PASS（login 正确 / 错误 / 锁定 / logout / me 未登录+已登录）

如果"5 次锁"测试因为 rate limiter 状态在之前 it 中已经累计而提前锁，把它移到 it 顺序的最后。

- [ ] **Step 16: 全量 admin 测试**

Run: `cd apps/admin && bun test`
Expected: health (1) + session (5) + rate-limit (4) + auth (5) = 15 用例 PASS

- [ ] **Step 17: typecheck + lint**

Run: `pnpm typecheck && pnpm exec biome check --write apps/admin && pnpm lint`
Expected: 全过

- [ ] **Step 18: Commit**

```bash
git add apps/admin/server/lib apps/admin/server/routes apps/admin/server/__tests__ apps/admin/server/app.ts
git commit -m "feat(admin): HMAC session + LRU rate-limit + /api/login /logout /me"
```

---

## Phase C: Admin server 查询 + 反代图

### Task 6: 查询封装 + devices/tasks routes

**Files:**
- Create: `apps/admin/server/lib/queries.ts`
- Create: `apps/admin/server/routes/devices.ts`
- Create: `apps/admin/server/routes/tasks.ts`
- Create: `apps/admin/server/__tests__/lib/queries.test.ts`
- Create: `apps/admin/server/__tests__/routes/devices.test.ts`
- Create: `apps/admin/server/__tests__/routes/tasks.test.ts`
- Modify: `apps/admin/server/app.ts` (use devicesRoutes / tasksRoutes)

为了让 queries 测试能跑，需要在测试启动前 seed 一些 tasks 到 SQLite。复用 `runMigrations` 建表 + `createDb` writer mode 写入。

- [ ] **Step 1: 写 queries 测试（先失败）**

`apps/admin/server/__tests__/lib/queries.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { unlinkSync } from 'node:fs'

const TEST_DB = './artifacts/test-admin-queries.sqlite'
try {
  unlinkSync(TEST_DB)
  unlinkSync(`${TEST_DB}-wal`)
  unlinkSync(`${TEST_DB}-shm`)
} catch {}

process.env.ADMIN_PASSWORD = 'pass-1234-aaaa'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = TEST_DB
process.env.BFF_INTERNAL_URL = 'http://localhost:9999'
process.env.PORT = '0'

const { runMigrations, createDb } = await import('@image-playground/db')
runMigrations(TEST_DB)

// seed 写入数据
const writer = createDb(TEST_DB)
const now = Date.now()
const dayMs = 24 * 60 * 60 * 1000
function seedTask(args: {
  id: string
  device: string
  provider: 'openai-compat' | 'gemini'
  model: string
  status: 'completed' | 'failed' | 'queued'
  daysAgo: number
}) {
  writer.db
    .insert(writer.schema.tasks)
    .values({
      id: args.id,
      provider: args.provider,
      model: args.model,
      status: args.status,
      request_payload: { prompt: 'p', device_id: args.device } as never,
      submitted_at: now - args.daysAgo * dayMs,
      ...(args.status === 'completed' ? { completed_at: now - args.daysAgo * dayMs + 1000 } : {}),
    })
    .run()
}

// dev-A 设备：今天 3 个 task（2 完成 1 失败）
seedTask({ id: 't1', device: 'dev-A-aaaa', provider: 'openai-compat', model: 'gpt-image-2', status: 'completed', daysAgo: 0 })
seedTask({ id: 't2', device: 'dev-A-aaaa', provider: 'openai-compat', model: 'gpt-image-2', status: 'completed', daysAgo: 0 })
seedTask({ id: 't3', device: 'dev-A-aaaa', provider: 'gemini', model: 'gemini-3-pro', status: 'failed', daysAgo: 0 })
// dev-B 设备：5 天前 1 个 task
seedTask({ id: 't4', device: 'dev-B-bbbb', provider: 'gemini', model: 'gemini-3-pro', status: 'completed', daysAgo: 5 })
// dev-OLD：30 天前 1 个 task（range=7d 不应包含）
seedTask({ id: 't5', device: 'dev-OLD-aa', provider: 'openai-compat', model: 'gpt-image-2', status: 'completed', daysAgo: 30 })

const { listDevices, getDeviceDetail, getTask } = await import('../../lib/queries')

describe('listDevices', () => {
  it('range=7d 不包含 30 天前的 dev-OLD', async () => {
    const result = await listDevices('7d', 'last_seen')
    const ids = result.devices.map((d) => d.device_id)
    expect(ids).toContain('dev-A-aaaa')
    expect(ids).toContain('dev-B-bbbb')
    expect(ids).not.toContain('dev-OLD-aa')
    expect(result.truncated).toBe(false)
  })

  it('sort=last_seen：dev-A（今天）在 dev-B（5 天前）前面', async () => {
    const result = await listDevices('7d', 'last_seen')
    const idxA = result.devices.findIndex((d) => d.device_id === 'dev-A-aaaa')
    const idxB = result.devices.findIndex((d) => d.device_id === 'dev-B-bbbb')
    expect(idxA).toBeLessThan(idxB)
  })

  it('dev-A 的聚合：total=3 ok=2 fail=1', async () => {
    const result = await listDevices('7d', 'last_seen')
    const devA = result.devices.find((d) => d.device_id === 'dev-A-aaaa')!
    expect(devA.total).toBe(3)
    expect(devA.ok_count).toBe(2)
    expect(devA.fail_count).toBe(1)
    expect(devA.models).toEqual(expect.arrayContaining(['gpt-image-2', 'gemini-3-pro']))
  })
})

describe('getDeviceDetail', () => {
  it('dev-A 详情 task 列表含 3 条 + 不含 result_payload 字段', async () => {
    const detail = await getDeviceDetail('dev-A-aaaa', '7d')
    expect(detail.device.device_id).toBe('dev-A-aaaa')
    expect(detail.tasks).toHaveLength(3)
    expect(detail.truncated).toBe(false)
    // 字段白名单：不含 result_payload
    expect((detail.tasks[0] as Record<string, unknown>).result_payload).toBeUndefined()
  })

  it('不存在的设备返回空 tasks', async () => {
    const detail = await getDeviceDetail('dev-NOPE', '7d')
    expect(detail.device).toBeNull()
    expect(detail.tasks).toEqual([])
  })
})

describe('getTask', () => {
  it('返回 task 全字段（含 result_meta）剔除 result_payload', async () => {
    const task = await getTask('t1')
    expect(task).not.toBeNull()
    expect(task!.id).toBe('t1')
    expect((task as Record<string, unknown>).result_payload).toBeUndefined()
    expect(task!.result_meta).toBeDefined()
  })

  it('不存在的 task → null', async () => {
    const task = await getTask('nope')
    expect(task).toBeNull()
  })
})

afterAll(() => writer.sqlite.close())
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/admin && bun test server/__tests__/lib/queries.test.ts`
Expected: FAIL — queries module not found

- [ ] **Step 3: 写 queries.ts**

`apps/admin/server/lib/queries.ts`:

```ts
import { createDb, type schema as Schema } from '@image-playground/db'
import { eq, sql } from 'drizzle-orm'
import { config } from '../config'

const { db, schema } = createDb(config.databaseUrl, { readonly: true })

export type Range = '1d' | '7d' | '30d'
export type SortKey = 'last_seen' | 'today_count' | 'total_count'

function rangeMs(range: Range): number {
  return range === '1d' ? 24 * 3600_000 : range === '7d' ? 7 * 24 * 3600_000 : 30 * 24 * 3600_000
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

export interface DeviceRow {
  device_id: string
  first_seen: number
  last_seen: number
  total: number
  ok_count: number
  fail_count: number
  models: string[]
  today_count: number
}

export interface ListDevicesResult {
  devices: DeviceRow[]
  truncated: boolean
}

const LIST_LIMIT = 500

export async function listDevices(range: Range, sort: SortKey): Promise<ListDevicesResult> {
  const since = Date.now() - rangeMs(range)
  const today = todayDate()
  const orderBy =
    sort === 'last_seen'
      ? sql`MAX(submitted_at) DESC`
      : sort === 'total_count'
        ? sql`COUNT(*) DESC`
        : sql`today_count DESC`

  // 单条聚合 SQL：避免 N+1。LEFT JOIN daily_quota 拿今日 count；GROUP_CONCAT 模型 chip。
  // 注意：device_id 是 VIRTUAL 生成列，drizzle schema 没声明，只能 raw sql 访问。
  // db.all(sql`...`) 返回 unknown[]（每行一个 plain object，列名 = property key）
  const rows = (await db.all(sql`
    SELECT
      t.device_id AS device_id,
      MIN(t.submitted_at) AS first_seen,
      MAX(t.submitted_at) AS last_seen,
      COUNT(*) AS total,
      SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS ok_count,
      SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) AS fail_count,
      GROUP_CONCAT(DISTINCT t.model) AS models_csv,
      COALESCE(q.count, 0) AS today_count
    FROM tasks t
    LEFT JOIN daily_quota q ON q.device_id = t.device_id AND q.date = ${today}
    WHERE t.submitted_at >= ${since} AND t.device_id IS NOT NULL
    GROUP BY t.device_id
    ORDER BY ${orderBy}
    LIMIT ${LIST_LIMIT + 1}
  `)) as unknown as Array<Record<string, unknown>>

  const list = rows.map(
    (r): DeviceRow => ({
      device_id: String(r.device_id),
      first_seen: Number(r.first_seen),
      last_seen: Number(r.last_seen),
      total: Number(r.total),
      ok_count: Number(r.ok_count),
      fail_count: Number(r.fail_count),
      models: String(r.models_csv ?? '').split(',').filter(Boolean),
      today_count: Number(r.today_count),
    }),
  )

  const truncated = list.length > LIST_LIMIT
  return { devices: list.slice(0, LIST_LIMIT), truncated }
}

export interface DeviceDetailResult {
  device: DeviceRow | null
  tasks: TaskListItem[]
  truncated: boolean
}

export interface TaskListItem {
  id: string
  provider: string
  model: string
  status: string
  submitted_at: number
  started_at: number | null
  completed_at: number | null
  error_type: string | null
  /** request_payload JSON（含 prompt / device_id 等）；体积可控 */
  request_payload: unknown
}

export async function getDeviceDetail(
  deviceId: string,
  range: Range,
): Promise<DeviceDetailResult> {
  const since = Date.now() - rangeMs(range)
  const today = todayDate()

  const [deviceRowsRaw, taskRows] = await Promise.all([
    db.all(sql`
      SELECT
        t.device_id AS device_id,
        MIN(t.submitted_at) AS first_seen,
        MAX(t.submitted_at) AS last_seen,
        COUNT(*) AS total,
        SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS ok_count,
        SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) AS fail_count,
        GROUP_CONCAT(DISTINCT t.model) AS models_csv,
        COALESCE(q.count, 0) AS today_count
      FROM tasks t
      LEFT JOIN daily_quota q ON q.device_id = t.device_id AND q.date = ${today}
      WHERE t.device_id = ${deviceId} AND t.submitted_at >= ${since}
      GROUP BY t.device_id
    `) as unknown as Array<Record<string, unknown>>,
    // task 列表：select 字段白名单（**不取 result_payload**，5-10MB 字段）。
    // where 子句用 raw sql 模板：device_id 是 VIRTUAL 列，drizzle schema 没声明，
    // 不能用 schema.tasks.device_id 引用；但 raw sql 字面列名 + bind param 安全。
    // Drizzle 仍负责 select 字段的 mode:'json' 解码（request_payload 自动 parse）。
    db
      .select({
        id: schema.tasks.id,
        provider: schema.tasks.provider,
        model: schema.tasks.model,
        status: schema.tasks.status,
        submitted_at: schema.tasks.submitted_at,
        started_at: schema.tasks.started_at,
        completed_at: schema.tasks.completed_at,
        error_type: schema.tasks.error_type,
        request_payload: schema.tasks.request_payload,
      })
      .from(schema.tasks)
      .where(sql`device_id = ${deviceId} AND submitted_at >= ${since}`)
      .orderBy(sql`submitted_at DESC`)
      .limit(LIST_LIMIT + 1),
  ])

  const drow = deviceRowsRaw[0]
  const device: DeviceRow | null = drow
    ? {
        device_id: String(drow.device_id),
        first_seen: Number(drow.first_seen),
        last_seen: Number(drow.last_seen),
        total: Number(drow.total),
        ok_count: Number(drow.ok_count),
        fail_count: Number(drow.fail_count),
        models: String(drow.models_csv ?? '').split(',').filter(Boolean),
        today_count: Number(drow.today_count),
      }
    : null

  const truncated = taskRows.length > LIST_LIMIT
  return {
    device,
    tasks: taskRows.slice(0, LIST_LIMIT) as TaskListItem[],
    truncated,
  }
}

export interface TaskDetail extends TaskListItem {
  result_payload: never  // explicit removal hint
  result_meta: { images: Array<{ index: number; mime: string }>; raw_image_urls?: string[] }
  error_message: string | null
}

export async function getTask(taskId: string): Promise<Omit<TaskDetail, 'result_payload'> | null> {
  const rows = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, taskId))
    .limit(1)
  const task = rows[0]
  if (!task) return null

  // 复用 BFF extractMeta —— 但 packages/db 不依赖 BFF lib，且 admin server 也不应
  // import BFF 内部 lib（layering）。在 admin server 里复制最小实现（仅产出 index/mime）：
  const images = extractImagesMeta(task.provider, task.result_payload)

  const { result_payload, ...rest } = task as unknown as Record<string, unknown>
  return {
    ...(rest as unknown as TaskListItem),
    error_message: (task as Record<string, unknown>).error_message as string | null,
    result_meta: { images },
  }
}

/** 最小实现：从原始 result_payload 抽 image meta（index + mime），不解 base64 */
function extractImagesMeta(
  provider: string,
  payload: unknown,
): Array<{ index: number; mime: string }> {
  if (!payload || typeof payload !== 'object') return []
  if (provider === 'openai-compat') {
    const data = (payload as { data?: unknown[] }).data
    if (!Array.isArray(data)) return []
    return data.map((_d, i) => ({ index: i, mime: 'image/png' }))
  }
  if (provider === 'gemini') {
    const candidates = (payload as { candidates?: unknown[] }).candidates
    if (!Array.isArray(candidates)) return []
    const parts = (candidates[0] as { content?: { parts?: unknown[] } } | undefined)?.content?.parts
    if (!Array.isArray(parts)) return []
    const imgs: Array<{ index: number; mime: string }> = []
    let idx = 0
    for (const p of parts) {
      const inlineData = (p as { inlineData?: { mimeType?: string } } | undefined)?.inlineData
      if (inlineData?.mimeType) imgs.push({ index: idx++, mime: inlineData.mimeType })
    }
    return imgs
  }
  return []
}
```

- [ ] **Step 4: 跑 queries 测试确认通过**

Run: `cd apps/admin && bun test server/__tests__/lib/queries.test.ts`
Expected: 7 个用例 PASS

如果 `db.run(sql\`...\`)` 返回结构不是 `{rows: [...]}`，调整 unmarshal。Drizzle bun-sqlite 的 raw 接口可能直接返数组——按实际报错调整。

- [ ] **Step 5: 写 routes/devices.ts**

`apps/admin/server/routes/devices.ts`:

```ts
import { Elysia, t } from 'elysia'
import { requireAuth } from '../lib/middleware'
import { getDeviceDetail, listDevices, type Range, type SortKey } from '../lib/queries'

const VALID_RANGES: Range[] = ['1d', '7d', '30d']
const VALID_SORTS: SortKey[] = ['last_seen', 'today_count', 'total_count']

export const devicesRoutes = new Elysia()
  .use(requireAuth)
  .get(
    '/api/devices',
    async ({ query }) => {
      const range = (VALID_RANGES.includes(query.range as Range) ? query.range : '7d') as Range
      const sort = (VALID_SORTS.includes(query.sort as SortKey) ? query.sort : 'last_seen') as SortKey
      return await listDevices(range, sort)
    },
    {
      query: t.Object({
        range: t.Optional(t.String()),
        sort: t.Optional(t.String()),
      }),
    },
  )
  .get(
    '/api/devices/:id',
    async ({ params, query, set }) => {
      const range = (VALID_RANGES.includes(query.range as Range) ? query.range : '7d') as Range
      const detail = await getDeviceDetail(params.id, range)
      if (!detail.device) {
        set.status = 404
        return { error: 'device_not_found' }
      }
      return detail
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ range: t.Optional(t.String()) }),
    },
  )
```

- [ ] **Step 6: 写 routes/tasks.ts**

`apps/admin/server/routes/tasks.ts`:

```ts
import { Elysia, t } from 'elysia'
import { requireAuth } from '../lib/middleware'
import { getTask } from '../lib/queries'

export const tasksRoutes = new Elysia()
  .use(requireAuth)
  .get(
    '/api/tasks/:id',
    async ({ params, set }) => {
      const task = await getTask(params.id)
      if (!task) {
        set.status = 404
        return { error: 'task_not_found' }
      }
      return task
    },
    { params: t.Object({ id: t.String() }) },
  )
```

- [ ] **Step 7: 写 routes 测试**

`apps/admin/server/__tests__/routes/devices.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { unlinkSync } from 'node:fs'

const TEST_DB = './artifacts/test-admin-routes.sqlite'
try {
  unlinkSync(TEST_DB)
  unlinkSync(`${TEST_DB}-wal`)
  unlinkSync(`${TEST_DB}-shm`)
} catch {}

process.env.ADMIN_PASSWORD = 'pass-1234-aaaa'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = TEST_DB
process.env.BFF_INTERNAL_URL = 'http://localhost:9999'
process.env.PORT = '0'

const { runMigrations, createDb } = await import('@image-playground/db')
runMigrations(TEST_DB)
const writer = createDb(TEST_DB)
const now = Date.now()
writer.db
  .insert(writer.schema.tasks)
  .values({
    id: 'task-A1',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'completed',
    request_payload: { prompt: 'p', device_id: 'dev-A-route' } as never,
    submitted_at: now,
    completed_at: now + 1000,
  })
  .run()

const { app } = await import('../../app')

async function login() {
  const res = await app.handle(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'pass-1234-aaaa' }),
    }),
  )
  return res.headers.get('set-cookie')!.split(';')[0]!
}

describe('GET /api/devices', () => {
  it('未登录 → 401', async () => {
    const res = await app.handle(new Request('http://localhost/api/devices'))
    expect(res.status).toBe(401)
  })

  it('登录后返回 devices 列表', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/devices?range=7d&sort=last_seen', {
        headers: { cookie },
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { devices: Array<{ device_id: string }>; truncated: boolean }
    expect(body.devices.map((d) => d.device_id)).toContain('dev-A-route')
    expect(body.truncated).toBe(false)
  })
})

describe('GET /api/devices/:id', () => {
  it('未登录 → 401', async () => {
    const res = await app.handle(new Request('http://localhost/api/devices/dev-A-route'))
    expect(res.status).toBe(401)
  })

  it('已知设备返回详情', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/devices/dev-A-route?range=7d', { headers: { cookie } }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { device: { device_id: string }; tasks: unknown[] }
    expect(body.device.device_id).toBe('dev-A-route')
    expect(body.tasks.length).toBeGreaterThan(0)
  })

  it('未知设备 → 404', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/devices/nope?range=7d', { headers: { cookie } }),
    )
    expect(res.status).toBe(404)
  })
})
```

`apps/admin/server/__tests__/routes/tasks.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'
import { unlinkSync } from 'node:fs'

const TEST_DB = './artifacts/test-admin-tasks.sqlite'
try {
  unlinkSync(TEST_DB)
  unlinkSync(`${TEST_DB}-wal`)
  unlinkSync(`${TEST_DB}-shm`)
} catch {}

process.env.ADMIN_PASSWORD = 'pass-1234-aaaa'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = TEST_DB
process.env.BFF_INTERNAL_URL = 'http://localhost:9999'
process.env.PORT = '0'

const { runMigrations, createDb } = await import('@image-playground/db')
runMigrations(TEST_DB)
const writer = createDb(TEST_DB)
const now = Date.now()
writer.db
  .insert(writer.schema.tasks)
  .values({
    id: 'task-T1',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'completed',
    request_payload: { prompt: 'p', device_id: 'dev-T' } as never,
    result_payload: { data: [{ b64_json: 'AAAA' }] } as never,
    submitted_at: now,
    completed_at: now + 1000,
  })
  .run()

const { app } = await import('../../app')

async function login() {
  const res = await app.handle(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'pass-1234-aaaa' }),
    }),
  )
  return res.headers.get('set-cookie')!.split(';')[0]!
}

describe('GET /api/tasks/:id', () => {
  it('未登录 → 401', async () => {
    const res = await app.handle(new Request('http://localhost/api/tasks/task-T1'))
    expect(res.status).toBe(401)
  })

  it('已知 task：返回 result_meta，剔除 result_payload', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/task-T1', { headers: { cookie } }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toBe('task-T1')
    expect(body.result_payload).toBeUndefined()
    const meta = body.result_meta as { images: unknown[] }
    expect(meta.images.length).toBe(1)
  })

  it('未知 task → 404', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/nope', { headers: { cookie } }),
    )
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 8: 改 app.ts use devicesRoutes / tasksRoutes**

修改 `apps/admin/server/app.ts`：

```ts
import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'
import { config } from './config'
import { authRoutes } from './routes/auth'
import { devicesRoutes } from './routes/devices'
import { tasksRoutes } from './routes/tasks'

const corsOrigin =
  config.corsOrigins === '*'
    ? true
    : config.corsOrigins.split(',').map((s) => s.trim()).filter(Boolean)

export const app = new Elysia()
  .use(cors({ origin: corsOrigin, credentials: true }))
  .get('/health', () => ({ ok: true }))
  .use(authRoutes)
  .use(devicesRoutes)
  .use(tasksRoutes)
```

- [ ] **Step 9: 跑测试确认通过**

Run: `cd apps/admin && bun test`
Expected: health (1) + session (5) + rate-limit (4) + auth (5) + queries (7) + devices (4) + tasks (3) = 29 用例 PASS

- [ ] **Step 10: typecheck + lint**

Run: `pnpm typecheck && pnpm exec biome check --write apps/admin && pnpm lint`
Expected: 0 errors

- [ ] **Step 11: Commit**

```bash
git add apps/admin/server/lib/queries.ts apps/admin/server/routes apps/admin/server/__tests__/lib/queries.test.ts apps/admin/server/__tests__/routes apps/admin/server/app.ts
git commit -m "feat(admin): /api/devices /api/devices/:id /api/tasks/:id 只读查询"
```

---

### Task 7: 反代图片 + 参考图

**Files:**
- Create: `apps/admin/server/lib/task-meta-cache.ts`
- Create: `apps/admin/server/routes/images.ts`
- Create: `apps/admin/server/__tests__/lib/task-meta-cache.test.ts`
- Create: `apps/admin/server/__tests__/routes/images.test.ts`
- Modify: `apps/admin/server/app.ts` (use imagesRoutes)

- [ ] **Step 1: 写 task-meta-cache 测试（先失败）**

`apps/admin/server/__tests__/lib/task-meta-cache.test.ts`:

```ts
import { describe, expect, it } from 'bun:test'

process.env.ADMIN_PASSWORD = 'pass-1234-aaaa'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = './artifacts/test-admin-cache.sqlite'
process.env.PORT = '0'

const { createTaskMetaCache } = await import('../../lib/task-meta-cache')

describe('createTaskMetaCache', () => {
  it('miss 时调 loader；命中后再调不触发 loader', async () => {
    let loaderCalls = 0
    const cache = createTaskMetaCache({
      maxEntries: 10,
      ttlMs: 30_000,
      load: async (taskId) => {
        loaderCalls++
        return { provider: 'openai-compat', model: 'm1', taskId }
      },
    })
    const r1 = await cache.get('t1')
    const r2 = await cache.get('t1')
    expect(loaderCalls).toBe(1)
    expect(r1.provider).toBe('openai-compat')
    expect(r2).toBe(r1)
  })

  it('TTL 过后 miss 重新 load', async () => {
    let loaderCalls = 0
    const cache = createTaskMetaCache({
      maxEntries: 10,
      ttlMs: 5, // 5ms
      load: async (taskId) => {
        loaderCalls++
        return { provider: 'gemini', model: 'm2', taskId }
      },
    })
    await cache.get('t-ttl')
    await new Promise((r) => setTimeout(r, 20))
    await cache.get('t-ttl')
    expect(loaderCalls).toBe(2)
  })

  it('loader 返 null：缓存 null（避免反复 SQL）', async () => {
    let loaderCalls = 0
    const cache = createTaskMetaCache({
      maxEntries: 10,
      ttlMs: 30_000,
      load: async () => {
        loaderCalls++
        return null
      },
    })
    expect(await cache.get('missing')).toBeNull()
    expect(await cache.get('missing')).toBeNull()
    expect(loaderCalls).toBe(1)
  })

  it('maxEntries 满后淘汰最老', async () => {
    let aLoadCount = 0
    const cache = createTaskMetaCache<{ taskId: string }>({
      maxEntries: 2,
      ttlMs: 30_000,
      load: async (taskId) => {
        if (taskId === 'a') aLoadCount++
        return { taskId }
      },
    })
    await cache.get('a') // a load #1, entries = {a}
    await cache.get('b') // entries = {a, b}
    await cache.get('c') // 容量满 → 淘汰 a；entries = {b, c}
    await cache.get('a') // a 已淘汰，重 load → load #2; entries = {c, a}
    expect(aLoadCount).toBe(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/admin && bun test server/__tests__/lib/task-meta-cache.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写 task-meta-cache.ts**

`apps/admin/server/lib/task-meta-cache.ts`:

```ts
/**
 * 短 TTL in-memory LRU cache。给反代图片端点用：单 task n=4 张图会触发 4 次
 * /image?idx=N，每次都 SELECT 一次 tasks 浪费；缓存 (provider, model) 30s。
 */

interface Entry<V> {
  value: V | null
  expiresAt: number
}

export interface TaskMetaCacheOptions<V> {
  maxEntries: number
  ttlMs: number
  load: (taskId: string) => Promise<V | null>
}

export interface TaskMetaCache<V> {
  get(taskId: string): Promise<V | null>
}

export function createTaskMetaCache<V>(opts: TaskMetaCacheOptions<V>): TaskMetaCache<V> {
  const entries = new Map<string, Entry<V>>()

  function touch(key: string, entry: Entry<V>) {
    entries.delete(key)
    entries.set(key, entry)
    while (entries.size > opts.maxEntries) {
      const oldest = entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  return {
    async get(taskId) {
      const now = Date.now()
      const cached = entries.get(taskId)
      if (cached && cached.expiresAt > now) {
        touch(taskId, cached) // refresh LRU position
        return cached.value
      }
      const value = await opts.load(taskId)
      touch(taskId, { value, expiresAt: now + opts.ttlMs })
      return value
    },
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/admin && bun test server/__tests__/lib/task-meta-cache.test.ts`
Expected: 4 个用例 PASS

- [ ] **Step 5: 写 images 路由测试**

`apps/admin/server/__tests__/routes/images.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { unlinkSync } from 'node:fs'

const TEST_DB = './artifacts/test-admin-images.sqlite'
try {
  unlinkSync(TEST_DB)
  unlinkSync(`${TEST_DB}-wal`)
  unlinkSync(`${TEST_DB}-shm`)
} catch {}

// 启一个 mock BFF 服务器在 random port
const mockBffPort = 39999
let mockBff: { stop: () => void }
const fakeImageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]) // PNG magic

process.env.ADMIN_PASSWORD = 'pass-1234-aaaa'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = TEST_DB
process.env.BFF_INTERNAL_URL = `http://localhost:${mockBffPort}`
process.env.PORT = '0'

const { runMigrations, createDb } = await import('@image-playground/db')
runMigrations(TEST_DB)
const writer = createDb(TEST_DB)
const now = Date.now()
// task with openai result + has 1 image
writer.db
  .insert(writer.schema.tasks)
  .values({
    id: 'img-task-1',
    provider: 'openai-compat',
    model: 'gpt-image-2',
    status: 'completed',
    request_payload: { prompt: 'p', device_id: 'dev-img' } as never,
    result_payload: { data: [{ b64_json: 'AAAA' }] } as never,
    submitted_at: now,
    completed_at: now + 1000,
  })
  .run()
// task with gemini that has inlineData (used by input-image test)
writer.db
  .insert(writer.schema.tasks)
  .values({
    id: 'img-task-gem',
    provider: 'gemini',
    model: 'gemini-3-pro',
    status: 'completed',
    request_payload: {
      prompt: 'p',
      device_id: 'dev-img',
      input_images: ['data:image/png;base64,QkFTRTY0'],
    } as never,
    result_payload: {
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'QkFTRTY0' } }] } },
      ],
    } as never,
    submitted_at: now,
    completed_at: now + 1000,
  })
  .run()

beforeAll(() => {
  // 极简 mock BFF：任何 /v1/queue/.../result/.../binary 都返 fake bytes
  mockBff = Bun.serve({
    port: mockBffPort,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname.includes('/binary')) {
        return new Response(fakeImageBytes, {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(fakeImageBytes.length) },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
})

afterAll(() => {
  mockBff?.stop()
})

const { app } = await import('../../app')

async function login() {
  const res = await app.handle(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'pass-1234-aaaa' }),
    }),
  )
  return res.headers.get('set-cookie')!.split(';')[0]!
}

describe('GET /api/tasks/:id/image', () => {
  it('未登录 → 401', async () => {
    const res = await app.handle(new Request('http://localhost/api/tasks/img-task-1/image?idx=0'))
    expect(res.status).toBe(401)
  })

  it('已知 task：反代 BFF binary 返 image bytes', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/img-task-1/image?idx=0', { headers: { cookie } }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes[0]).toBe(0x89)
    expect(bytes[1]).toBe(0x50)
  })

  it('未知 task → 404', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/nope/image?idx=0', { headers: { cookie } }),
    )
    expect(res.status).toBe(404)
  })
})

describe('GET /api/tasks/:id/input-image', () => {
  it('Gemini task 抽出 inlineData 返 image bytes', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/img-task-gem/input-image?idx=0', {
        headers: { cookie },
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/png')
  })

  it('OpenAI task → 422 + input_image_not_archived', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/img-task-1/input-image?idx=0', {
        headers: { cookie },
      }),
    )
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error_code: string }
    expect(body.error_code).toBe('input_image_not_archived')
  })

  it('未知 task → 404 + task_not_found', async () => {
    const cookie = await login()
    const res = await app.handle(
      new Request('http://localhost/api/tasks/nope/input-image?idx=0', { headers: { cookie } }),
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error_code: string }
    expect(body.error_code).toBe('task_not_found')
  })
})
```

- [ ] **Step 6: 写 routes/images.ts**

`apps/admin/server/routes/images.ts`:

```ts
import { createDb } from '@image-playground/db'
import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { config } from '../config'
import { requireAuth } from '../lib/middleware'
import { createTaskMetaCache } from '../lib/task-meta-cache'

const { db, schema } = createDb(config.databaseUrl, { readonly: true })

interface TaskMeta {
  provider: string
  model: string
}

const taskMetaCache = createTaskMetaCache<TaskMeta>({
  maxEntries: 200,
  ttlMs: 30_000,
  load: async (taskId) => {
    const rows = await db
      .select({ provider: schema.tasks.provider, model: schema.tasks.model })
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
      .limit(1)
    return rows[0] ?? null
  },
})

export const imagesRoutes = new Elysia()
  .use(requireAuth)
  .get(
    '/api/tasks/:id/image',
    async ({ params, query, set }) => {
      const meta = await taskMetaCache.get(params.id)
      if (!meta) {
        set.status = 404
        return { error_code: 'task_not_found' }
      }
      const idx = query.idx ?? '0'
      const upstream = `${config.bffInternalUrl}/v1/queue/requests/${params.id}/image/${idx}`
      const res = await fetch(upstream)
      if (!res.ok) {
        set.status = res.status
        return { error_code: 'upstream_failed', upstream_status: res.status }
      }
      set.status = 200
      set.headers['cache-control'] = 'private, max-age=600'
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
      set.headers['content-type'] = contentType
      return new Response(res.body, { status: 200, headers: { 'content-type': contentType } })
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ idx: t.Optional(t.String()) }),
    },
  )
  .get(
    '/api/tasks/:id/input-image',
    async ({ params, query, set }) => {
      const rows = await db
        .select({
          provider: schema.tasks.provider,
          request_payload: schema.tasks.request_payload,
        })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, params.id))
        .limit(1)
      const task = rows[0]
      if (!task) {
        set.status = 404
        return { error_code: 'task_not_found' }
      }
      if (task.provider !== 'gemini') {
        set.status = 422
        return { error_code: 'input_image_not_archived' }
      }
      // Gemini：从 request_payload.input_images 抽 data URL，或更深的 contents/parts/inlineData
      const idx = Number(query.idx ?? '0')
      const bytes = extractGeminiInputImage(task.request_payload, idx)
      if (!bytes) {
        set.status = 422
        return { error_code: 'input_image_not_archived' }
      }
      set.headers['cache-control'] = 'private, max-age=3600'
      set.headers['content-type'] = bytes.mime
      return new Response(bytes.data, { status: 200, headers: { 'content-type': bytes.mime } })
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ idx: t.Optional(t.String()) }),
    },
  )

function extractGeminiInputImage(
  payload: unknown,
  idx: number,
): { data: Uint8Array; mime: string } | null {
  // 前端 BFF 实际是把 input_images 作为 data URL 数组发给 BFF；BFF 再转 Gemini 格式
  // 转给 sub2api。tasks.request_payload 存的是前端原始 SubmitRequest，所以
  // `input_images: string[]` 优先尝试，元素是 'data:image/png;base64,...' 形式。
  const inputImages = (payload as { input_images?: unknown } | undefined)?.input_images
  if (Array.isArray(inputImages) && typeof inputImages[idx] === 'string') {
    return parseDataUrl(inputImages[idx] as string)
  }
  return null
}

function parseDataUrl(dataUrl: string): { data: Uint8Array; mime: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
  if (!match) return null
  const mime = match[1]!
  const base64 = match[2]!
  try {
    const bin = atob(base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { data: bytes, mime }
  } catch {
    return null
  }
}
```

- [ ] **Step 7: 改 app.ts**

修改 `apps/admin/server/app.ts`：加 `.use(imagesRoutes)`：

```ts
import { cors } from '@elysiajs/cors'
import { Elysia } from 'elysia'
import { config } from './config'
import { authRoutes } from './routes/auth'
import { devicesRoutes } from './routes/devices'
import { imagesRoutes } from './routes/images'
import { tasksRoutes } from './routes/tasks'

const corsOrigin =
  config.corsOrigins === '*'
    ? true
    : config.corsOrigins.split(',').map((s) => s.trim()).filter(Boolean)

export const app = new Elysia()
  .use(cors({ origin: corsOrigin, credentials: true }))
  .get('/health', () => ({ ok: true }))
  .use(authRoutes)
  .use(devicesRoutes)
  .use(tasksRoutes)
  .use(imagesRoutes)
```

- [ ] **Step 8: 跑全 admin 测试**

Run: `cd apps/admin && bun test`
Expected: 29 + cache (4) + images (5) = 38 用例 PASS

如果 images 测试某条因 BFF mock 没启动失败 → check `beforeAll` 顺序。

- [ ] **Step 9: 全项目 lint + typecheck + test**

```bash
pnpm exec biome check --write .
pnpm lint
pnpm typecheck
pnpm test
```

Expected: 全过（含 admin 新测试）

- [ ] **Step 10: Commit**

```bash
git add apps/admin/server/lib/task-meta-cache.ts apps/admin/server/routes/images.ts apps/admin/server/__tests__/lib/task-meta-cache.test.ts apps/admin/server/__tests__/routes/images.test.ts apps/admin/server/app.ts
git commit -m "feat(admin): /api/tasks/:id/image 反代 BFF + /input-image Gemini 抽参考图"
```

---

## Phase D: 端到端 smoke

### Task 8: 本地启动 admin server + curl 全链路

无新代码。只是 manual + commit free。

- [ ] **Step 1: 启 admin server**

```bash
cd apps/admin
ADMIN_PASSWORD=local-test-1234 \
ADMIN_COOKIE_SECRET=local-test-cookie-secret-32-bytes-aa \
BFF_INTERNAL_URL=http://127.0.0.1:37377 \
DATABASE_URL=../../artifacts/image-playground.sqlite \
PORT=37378 \
bun run server/index.ts
```

Expected: `✓ admin server listening on http://localhost:37378`

- [ ] **Step 2: health**

```bash
curl -s http://localhost:37378/health
```

Expected: `{"ok":true}`

- [ ] **Step 3: 未登录 401**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:37378/api/devices
```

Expected: `401`

- [ ] **Step 4: login**

```bash
curl -s -c /tmp/admin.cookie -X POST http://localhost:37378/api/login \
  -H 'content-type: application/json' \
  -d '{"password":"local-test-1234"}'
cat /tmp/admin.cookie | grep admin_session
```

Expected: 返回 `{"ok":true}` 且 /tmp/admin.cookie 含 admin_session

- [ ] **Step 5: devices**

```bash
curl -s -b /tmp/admin.cookie "http://localhost:37378/api/devices?range=7d&sort=last_seen" | jq .
```

Expected: 返回 `{"devices":[...],"truncated":false}`，至少有一个 device（来自前面 per-device-quota 部署后的真实使用记录）。

- [ ] **Step 6: device detail**

```bash
# 用 step 5 拿到的 device_id
DEVICE_ID=<paste>
curl -s -b /tmp/admin.cookie "http://localhost:37378/api/devices/$DEVICE_ID?range=7d" | jq .device.device_id
```

Expected: 等于 $DEVICE_ID

- [ ] **Step 7: task detail**

```bash
# 用 step 6 task 列表里的 id
TASK_ID=<paste>
curl -s -b /tmp/admin.cookie "http://localhost:37378/api/tasks/$TASK_ID" | jq '.id, .result_meta'
```

Expected: 返回 task id + result_meta（如果是 completed task），且 result_payload 字段不在

- [ ] **Step 8: image 反代**

```bash
curl -s -b /tmp/admin.cookie "http://localhost:37378/api/tasks/$TASK_ID/image?idx=0" -o /tmp/img.png -w "HTTP %{http_code} %{size_download} bytes\n"
file /tmp/img.png
```

Expected: HTTP 200 + 几十 KB bytes + `file /tmp/img.png` 报 PNG/WebP 格式（前提是 BFF 跑着）

- [ ] **Step 9: 停服**

Ctrl-C 关掉 admin server

- [ ] **Step 10: Commit**（无代码改动，跳过）

---

## Implementation Notes

### 已知 deviation 风险

1. **`db.run(sql\`...\`)` 返回结构**：drizzle-orm bun-sqlite 的 raw SQL 返回值 shape 可能跟 plan 假设不一致（`{rows: [...]}` vs 直接数组）。Task 6 写完测试时如果 shape 报错，调整 unmarshal。

2. **Elysia 的 `set.headers['content-type'] = ...` 跟 `return new Response(...)` 的优先级**：Task 7 反代 image 端点 stream body 必须用 `return new Response(...)`，Elysia 不会改 Response 对象。需要确认 elysia 1.4 这一行为。如果它强行重写 Content-Type，改为构造 Response 时即设。

3. **`bun:test` 共享 process state**：rate-limit 测试 + auth 测试在同一文件共用 limiter 模块实例（module level singleton 在 routes/auth.ts）。bun:test 同文件内 it 顺序固定但跨文件不可预测——auth.test 的"5 次锁"测试要放最后一个 `it`。如果跨文件竞争，把 limiter 改成 routes/auth.ts 接收外部注入即可重构。本 plan 暂不必。

4. **Drizzle generated column**：`device_id` VIRTUAL 列在 drizzle schema 里**不**声明（schema.ts 不动），仅 SQL DDL 加。drizzle `db.select({ device_id })` 会失败（不在 schema）—— `queries.ts` 通过 raw `db.run(sql)` 访问 `device_id`，绕过 ORM 类型。

### Spec 之外的小决定

- HMAC 实现选 `node:crypto` 的 `createHmac` 而非 `crypto.subtle`（Bun 全支持，可读性更好）
- LRU 用 `Map`（JS 原生保插入顺序，删-再插即 LRU）而不引第三方 `lru-cache`
- `requireAuth` middleware 用 Elysia plugin `name`（Elysia 1.4 plugin dedup）+ `as: 'scoped'` 避免污染其它 routes

### 下一步（Plan B）

- Vite + Tailwind v4 + shadcn + TanStack Router 脚手架
- 前端 `<img src="/api/tasks/.../image?idx=0" />` 直接拿 admin server stream（已实现）
- 登录 / 设备列表 / 详情 UI
- launchd plist + cloudflared tunnel + deploy:local 部署改造
