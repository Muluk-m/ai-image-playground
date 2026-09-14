import { afterAll, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'

// Imported while DATABASE_URL still points at a database nobody can reach: the module must not bind
// a pool at import time, because a later test file in the same process would inherit that pool.
process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused_placeholder'
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
const { close, db, schema } = await import('../../db/client')

process.env.DATABASE_URL = await resetTestDatabase('bff_db_client_rebinding')

afterAll(async () => {
  await close()
})

it('binds to the DATABASE_URL in force at query time, and reopens after close', async () => {
  expect(await db.select().from(schema.tasks)).toEqual([])

  await close()

  expect(await db.select().from(schema.tasks)).toEqual([])
}, 30_000)
