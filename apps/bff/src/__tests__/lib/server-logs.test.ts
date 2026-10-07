import { afterAll, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

process.env.DATABASE_URL = await resetTestDatabase('bff_server_logs')
process.env.APP_ROLE = 'worker'
const { db, schema, close } = await import('../../db/client')
const { log, serverLogBuffer } = await import('../../lib/logger')
const { purgeServerLogs } = await import('../../lib/server-logs')
const { withRequestContext } = await import('../../lib/request-context')
afterAll(close)

describe('server log persistence', () => {
  it('collects the existing logger and automatically correlates requests before writing JSON fields', async () => {
    const handler = withRequestContext(async () => {
      log.error(
        {
          event: 'test.failed',
          taskId: 'test-task',
          err: new Error('test failure'),
          apiKey: 'secret-key-value',
        },
        'task failed',
      )
      return Response.json({ ok: true })
    })
    const response = await handler(
      new Request('http://localhost/test', { headers: { 'x-request-id': 'correlated-request' } }),
    )
    expect(response.headers.get('x-request-id')).toBe('correlated-request')
    await serverLogBuffer.drain()
    const [row] = await db
      .select()
      .from(schema.server_logs)
      .where(eq(schema.server_logs.event, 'test.failed'))
    expect(row).toMatchObject({
      service: 'worker',
      request_id: 'correlated-request',
      task_id: 'test-task',
      level: 'error',
      group_key: 'test.failed',
    })
    expect(row!.fields.apiKey).toBe('[REDACTED]')
    expect(row!.fields.err).toMatchObject({ message: 'test failure' })
  })
  it('purges expired logs while preserving retained logs', async () => {
    const [base] = await db.select().from(schema.server_logs).limit(1)
    await db
      .insert(schema.server_logs)
      .values({ ...base!, id: 'expired-log', at: Date.now() - 8 * 86400_000 })
    await purgeServerLogs()
    expect(
      await db.select().from(schema.server_logs).where(eq(schema.server_logs.id, 'expired-log')),
    ).toHaveLength(0)
    expect(
      await db.select().from(schema.server_logs).where(eq(schema.server_logs.id, base!.id)),
    ).toHaveLength(1)
  })
})
