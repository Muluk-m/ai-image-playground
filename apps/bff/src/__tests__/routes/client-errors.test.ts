import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { CLIENT_ERRORS_PATH } from '@image-playground/shared'

const bffRoot = resolve(import.meta.dir, '../../..')
process.env.PORT = '0'
process.env.DATABASE_URL = await resetTestDatabase('bff_client_errors')
process.env.OPERATOR_CONFIG_FILE = resolve(bffRoot, 'operator-config.example.json')
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.CLIENT_IP_SOURCE = 'x-forwarded-for'

const { app } = await import('../../app')
const { close, db, schema } = await import('../../db/client')
const { purgeOldClientErrors } = await import('../../lib/client-errors')

afterAll(async () => {
  await close()
})

beforeEach(async () => {
  await db.delete(schema.client_errors)
})

let address = 0
function report(body: unknown, init: { raw?: string; ip?: string } = {}): Promise<Response> {
  address += 1
  return app.handle(
    new Request(`http://localhost${CLIENT_ERRORS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain;charset=UTF-8',
        'user-agent': 'fixture-agent',
        'x-forwarded-for': init.ip ?? `198.51.100.${address}`,
      },
      body: init.raw ?? JSON.stringify(body),
    }),
  )
}

const stackAt = (asset: string, line: number) =>
  `TypeError: x is undefined\n    at render (https://muvloom.online/assets/${asset}:${line}:17)`

describe('POST /api/client-errors', () => {
  it('stores beacon reports and groups the same bug across builds', async () => {
    const response = await report({
      deviceId: 'device-fixture-01',
      errors: [
        {
          kind: 'error',
          name: 'TypeError',
          message: 'x is undefined at item 3',
          stack: stackAt('index-BxY12z9a.js', 120),
          url: 'https://muvloom.online/#/projects',
          release: 'build-a',
        },
        {
          kind: 'error',
          name: 'TypeError',
          message: 'x is undefined at item 17',
          stack: stackAt('index-Qr0p55Lm.js', 98),
          release: 'build-b',
        },
        { kind: 'boot', message: 'timeout', context: { rendered: false } },
        {
          kind: 'error',
          message: 'nul\u0000 byte',
          context: { 'k\u0000': 'v\u0000', literal: '\\u0000' },
        },
        { kind: 'not-a-kind', message: 'dropped' },
        { kind: 'error' },
      ],
    })
    expect(response.status).toBe(204)

    const rows = await db.select().from(schema.client_errors)
    expect(rows).toHaveLength(4)
    expect(rows.find((row) => row.message === 'nul byte')?.context).toEqual({
      k: 'v',
      literal: '\\u0000',
    })
    const runtime = rows.filter((row) => row.kind === 'error' && row.name === 'TypeError')
    expect(new Set(runtime.map((row) => row.fingerprint)).size).toBe(1)
    expect(runtime[0]).toMatchObject({
      device_id: 'device-fixture-01',
      user_agent: 'fixture-agent',
    })
    expect(rows.find((row) => row.kind === 'boot')?.context).toEqual({ rendered: false })
  })

  it('rejects unreadable bodies and oversize payloads', async () => {
    expect((await report(null, { raw: 'not json' })).status).toBe(400)
    expect((await report({ errors: 'nope' })).status).toBe(400)
    expect((await report(null, { raw: 'x'.repeat(70 * 1024) })).status).toBe(413)
  })

  it('throttles a looping page per device', async () => {
    const body = { deviceId: 'device-fixture-loop', errors: [{ kind: 'error', message: 'loop' }] }
    const statuses: number[] = []
    for (let i = 0; i < 12; i += 1) statuses.push((await report(body)).status)
    expect(statuses.filter((code) => code === 204)).toHaveLength(10)
    expect(statuses.at(-1)).toBe(429)
  })

  it('purges events past the retention window', async () => {
    await report({ errors: [{ kind: 'error', message: 'old' }] })
    expect(await purgeOldClientErrors(30 * 24 * 3600_000, Date.now() + 31 * 24 * 3600_000)).toBe(1)
    expect(await db.select().from(schema.client_errors)).toHaveLength(0)
  })
})
