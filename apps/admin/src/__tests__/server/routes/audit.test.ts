import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { ListAuditsResult } from '../../../../contracts'

const databaseUrl = await resetTestDatabase('admin_audit_route')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = databaseUrl
process.env.BFF_INTERNAL_URL = 'http://127.0.0.1:39999'
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.PORT = '0'

const writer = createDb(databaseUrl)
const newest = Date.now()
const older = newest - 60_000

// 四条同一毫秒写入 + 一条更早的：同刻写入是运营批量操作的常态（发布一批条目会在一个事务里
// 连写好几条），也正是 OFFSET 分页会漏行、keyset 必须靠 id 兜底的那种数据。
await writer.db.insert(writer.schema.operator_audits).values([
  {
    id: 'audit-a',
    operator_id: 'admin',
    action: 'inspiration.published',
    target_type: 'inspiration',
    target_id: 'item-a',
    details: { kind: 'showcase' },
    created_at: newest,
  },
  {
    id: 'audit-b',
    operator_id: 'admin',
    action: 'inspiration.published',
    target_type: 'inspiration',
    target_id: 'item-b',
    details: {},
    created_at: newest,
  },
  {
    id: 'audit-c',
    operator_id: 'admin',
    action: 'inspiration.published',
    target_type: 'inspiration',
    target_id: 'item-c',
    details: {},
    created_at: newest,
  },
  {
    id: 'audit-d',
    operator_id: 'admin',
    action: 'inspiration.published',
    target_type: 'inspiration',
    target_id: 'item-d',
    details: {},
    created_at: newest,
  },
  {
    id: 'audit-e',
    operator_id: 'operator-2',
    action: 'user.status.update',
    target_type: 'user',
    target_id: 'user-1',
    details: { status: 'disabled' },
    created_at: older,
  },
])

// Dynamic import keeps environment setup ahead of Admin configuration capture.
const { app } = await import('../../../../server/app')

async function login(): Promise<string> {
  const response = await app.handle(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.170' },
      body: JSON.stringify({ password: 'test-pass-1234' }),
    }),
  )
  return response.headers.get('set-cookie')!.split(';')[0]!
}

async function page(search: string): Promise<ListAuditsResult> {
  const response = await app.handle(
    new Request(`http://localhost/api/audits${search}`, {
      headers: { cookie: await login() },
    }),
  )
  expect(response.status).toBe(200)
  return (await response.json()) as ListAuditsResult
}

afterAll(async () => {
  await writer.close()
})

describe('GET /api/audits', () => {
  it('keeps paging past rows written in the same millisecond', async () => {
    const first = await page('?limit=2')
    expect(first.audits.map(({ id }) => id)).toEqual(['audit-d', 'audit-c'])
    expect(first.audits[0]).toMatchObject({
      operator_id: 'admin',
      action: 'inspiration.published',
      target_type: 'inspiration',
      target_id: 'item-d',
      created_at: newest,
    })
    expect(first.nextCursor).not.toBeNull()

    const second = await page(`?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)
    expect(second.audits.map(({ id }) => id)).toEqual(['audit-b', 'audit-a'])
    expect(second.nextCursor).not.toBeNull()

    const third = await page(`?limit=2&cursor=${encodeURIComponent(second.nextCursor!)}`)
    expect(third.audits.map(({ id }) => id)).toEqual(['audit-e'])
    expect(third.audits[0]?.details).toEqual({ status: 'disabled' })
    expect(third.nextCursor).toBeNull()
  })
})
