import { afterAll, describe, expect, it } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { adminReadFromExecute } from '../admin-read'
import { runPgMigrations } from '../pg-migrate'
import * as schema from '../pg-schema'

const pglite = await PGlite.create()
await runPgMigrations(async (ddl) => {
  await pglite.exec(ddl)
})
const db = drizzle(pglite, { schema })

describe('admin postgres read handle', () => {
  afterAll(async () => {
    await pglite.close()
  })

  it('reads device_id generated from request JSON', async () => {
    await db.insert(schema.tasks).values({
      id: 'admin-1',
      provider: 'openai-compat',
      model: 'gpt-image-2',
      status: 'completed',
      request_payload: { prompt: 'p', device_id: 'dev-pg-aaaa' },
      submitted_at: Date.now(),
      completed_at: Date.now(),
    })

    const read = adminReadFromExecute((query) => db.execute(query))
    const rows = await read.all(sql`
      SELECT device_id, model FROM tasks WHERE id = ${'admin-1'} LIMIT 1
    `)
    expect(rows[0]).toMatchObject({ device_id: 'dev-pg-aaaa', model: 'gpt-image-2' })
  })
})
