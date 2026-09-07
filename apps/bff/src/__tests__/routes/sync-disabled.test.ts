import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { Elysia } from 'elysia'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
// 登录开着、同步没开：端点必须 404。
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../login-only-operator-config.json')

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { syncRoutes } = await import('../../routes/sync')
const { capabilityManifest } = await import('../../lib/capabilities')

const app = new Elysia().use(syncRoutes)

describe('POST /api/sync without the capability', () => {
  it('answers 404 and keeps the capability off in the manifest', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 0 }),
      }),
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      error: 'capability_unavailable',
      capability: 'accounts:sync',
    })
    expect(capabilityManifest()['accounts:sync']).toBe(false)
  })

  it('answers 404 on the asset image endpoints too', async () => {
    const uploaded = await app.handle(
      new Request('http://localhost/api/sync/assets/image-1', {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array(8),
      }),
    )
    const downloaded = await app.handle(
      new Request('http://localhost/api/sync/assets/image-1', { method: 'GET' }),
    )

    expect(uploaded.status).toBe(404)
    expect(downloaded.status).toBe(404)
    expect(await downloaded.json()).toEqual({
      error: 'capability_unavailable',
      capability: 'accounts:sync',
    })
  })
})
