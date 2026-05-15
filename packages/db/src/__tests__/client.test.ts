import { describe, expect, it } from 'bun:test'
import { mkdirSync, unlinkSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { createDb } from '../client'
import { runMigrations } from '../migrate'

const TEST_DB = './artifacts/test-client.sqlite'

// 测试在 packages/db cwd 跑时 artifacts/ 不存在
mkdirSync('./artifacts', { recursive: true })

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
    db.insert(schema.tasks)
      .values({
        id: 'test-rw',
        provider: 'openai-compat',
        model: 'm',
        status: 'queued',
        request_payload: { prompt: 'x', device_id: 'd-aaaaaaaa' } as never,
        submitted_at: Date.now(),
      })
      .run()
    const rows = db.select().from(schema.tasks).where(eq(schema.tasks.id, 'test-rw')).all()
    expect(rows.length).toBe(1)
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
