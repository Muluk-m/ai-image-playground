import { afterAll, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'

process.env.DATABASE_URL = await resetTestDatabase('bff_server_logs')
process.env.APP_ROLE = 'worker'
const { db, schema, close } = await import('../../db/client')
const { log } = await import('../../lib/logger')
const { captureLogLines } = await import('../helpers/logCapture')
const { parseContainerLog } = await import('../../lib/container-logs')
const lines = captureLogLines(log)
const { purgeServerLogs, closeServerLogDatabase, writeServerLogs } = await import(
  '../../lib/server-logs'
)
const { withRequestContext } = await import('../../lib/request-context')
const { parseServerLog } = await import('../../lib/server-log-buffer')
afterAll(async () => {
  await closeServerLogDatabase()
  await close()
})

describe('server log persistence', () => {
  it('stores what the logger prints, correlated with its request, once the collector forwards it', async () => {
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
    const entries = lines.splice(0).map(
      (line) =>
        parseContainerLog({
          date: Date.now() / 1000,
          container_name: '/image-playground-paid-r20261007153518-2827408-worker',
          source: 'stdout',
          log: line,
        })!,
    )
    await writeServerLogs(entries)
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
  it('stores a NUL-containing diagnostic alongside ordinary logs without poisoning the batch', async () => {
    const identity = { service: 'worker' as const, instance: 'nul-test', version: 'release' }
    const malformed = parseServerLog(
      JSON.stringify({
        level: 50,
        time: Date.now(),
        event: 'test.nul',
        msg: 'bad\u0000message',
        'field\u0000name': 'value\u0000text',
      }),
      identity,
    )!
    const normal = parseServerLog(
      JSON.stringify({ level: 30, time: Date.now(), event: 'test.nul', msg: 'normal message' }),
      identity,
    )!
    await writeServerLogs([malformed, normal])
    const rows = await db
      .select()
      .from(schema.server_logs)
      .where(eq(schema.server_logs.event, 'test.nul'))
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === malformed.id)).toMatchObject({
      message: 'badmessage',
      fields: { fieldname: 'valuetext' },
    })
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
