import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { Elysia } from 'elysia'

process.env.PORT = '0'
process.env.DATABASE_URL = 'postgres://unused/unused'
// 同步配置开着但登录关着：同步依赖登录，端点仍必须 404。
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../sync-login-disabled-operator-config.json',
)

// Dynamic import keeps environment setup ahead of configuration module evaluation.
const { syncRoutes } = await import('../../routes/sync')
const { capabilityManifest } = await import('../../lib/capabilities')

const app = new Elysia().use(syncRoutes)

describe('POST /api/sync with sync configured on but login off', () => {
  it('answers 404 because sync depends on login', async () => {
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
