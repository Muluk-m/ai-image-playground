import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  SYNC_SETTINGS_MAX_BYTES,
  SYNC_TEMPLATE_PARAMS_MAX_BYTES,
  type SyncRequestBody,
  type SyncResponseBody,
} from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

const TEST_DB = await resetTestDatabase('bff_sync_routes')

process.env.PORT = '0'
process.env.DATABASE_URL = TEST_DB
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../sync-operator-config.json')

// Dynamic imports keep environment setup ahead of configuration capture.
const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { createUserSession } = await import('../../lib/user-session')
const { USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')

beforeEach(() => {
  setObjectStoreForTesting(new InMemoryObjectStore())
})

afterEach(() => {
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

/** 素材记录只有在图片本体已上传后才被接受。 */
async function uploadImage(cookie: string, imageId: string): Promise<void> {
  const response = await app.handle(
    new Request(`http://localhost/api/sync/assets/${imageId}`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'image/png' },
      body: new Uint8Array(8),
    }),
  )
  if (response.status !== 200) throw new Error(`asset upload failed: ${response.status}`)
}

async function resetDb() {
  await db.delete(schema.users)
}

async function createDevice(userId: string): Promise<string> {
  const token = await db.transaction((tx) => createUserSession(userId, tx))
  return `${USER_SESSION_COOKIE}=${token}`
}

async function createUser(id: string): Promise<string> {
  const now = Date.now()
  await db.insert(schema.users).values({
    id,
    username: id,
    password_hash: 'fixture-hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  return id
}

async function sync(
  cookie: string | null,
  body: SyncRequestBody,
): Promise<{ status: number; body: SyncResponseBody }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cookie) headers.cookie = cookie
  const response = await app.handle(
    new Request('http://localhost/api/sync', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, body: (await response.json()) as SyncResponseBody }
}

function template(overrides: Record<string, unknown> = {}) {
  return {
    id: 'template-1',
    name: 'Studio shot',
    prompt: 'a cat on {surface}',
    assetIds: ['asset-1', null],
    params: { size: '1024x1024', quality: 'high', n: 1 },
    createdAt: 1_000,
    updatedAt: 1_000,
    lastUsedAt: 1_000,
    ...overrides,
  }
}

function asset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'asset-1',
    name: 'Blue mug',
    imageId: 'image-hash-1',
    createdAt: 1_000,
    updatedAt: 1_000,
    lastUsedAt: 1_000,
    ...overrides,
  }
}

describe('POST /api/sync', () => {
  let deviceA: string
  let deviceB: string

  beforeEach(async () => {
    await resetDb()
    const userId = await createUser('sync-user')
    deviceA = await createDevice(userId)
    deviceB = await createDevice(userId)
  })

  it('rejects anonymous requests', async () => {
    const response = await sync(null, { version: 0 })
    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: 'unauthorized' } as never)
  })

  it('exposes accounts:sync in the client capability manifest', async () => {
    const manifest = await app.handle(new Request('http://localhost/api/capabilities'))
    expect(await manifest.json()).toMatchObject({ 'accounts:sync': true })
  })

  it('hands a template pushed by one device to the other', async () => {
    const pushed = await sync(deviceA, { version: 0, templates: [template()] })
    expect(pushed.status).toBe(200)
    expect(pushed.body.version).toBe(1)
    expect(pushed.body.templates).toEqual([template()] as never)

    const pulled = await sync(deviceB, { version: 0 })
    expect(pulled.body.version).toBe(1)
    expect(pulled.body.templates).toEqual([template()] as never)
    expect(pulled.body.assets).toEqual([])
    expect(pulled.body.settings).toBeNull()
  })

  it('returns nothing when the client already holds the current version', async () => {
    await sync(deviceA, { version: 0, templates: [template()] })
    const pulled = await sync(deviceB, { version: 0 })

    const again = await sync(deviceB, { version: pulled.body.version })
    expect(again.body.version).toBe(pulled.body.version)
    expect(again.body.templates).toEqual([])
    expect(again.body.assets).toEqual([])
    expect(again.body.settings).toBeNull()
  })

  it('keeps the later updatedAt and overwrites the loser', async () => {
    await sync(deviceA, { version: 0, templates: [template({ name: 'A', updatedAt: 2_000 })] })
    const loser = await sync(deviceB, {
      version: 0,
      templates: [template({ name: 'B', updatedAt: 1_500 })],
    })

    expect(loser.body.templates).toEqual([
      template({ name: 'A', updatedAt: 2_000, lastUsedAt: 1_000 }),
    ] as never)

    const pulledByB = await sync(deviceB, { version: 0 })
    expect(pulledByB.body.templates).toEqual([
      template({ name: 'A', updatedAt: 2_000, lastUsedAt: 1_000 }),
    ] as never)
  })

  it('lets a tombstone beat a later push of the older record', async () => {
    await sync(deviceA, { version: 0, templates: [template({ updatedAt: 1_000 })] })
    await sync(deviceA, {
      version: 1,
      templates: [{ id: 'template-1', updatedAt: 3_000, deletedAt: 3_000 }],
    })

    const stalePush = await sync(deviceB, {
      version: 0,
      templates: [template({ updatedAt: 1_000 })],
    })
    expect(stalePush.body.templates).toEqual([
      { id: 'template-1', updatedAt: 3_000, deletedAt: 3_000 },
    ] as never)

    const pulled = await sync(deviceB, { version: 0 })
    expect(pulled.body.templates).toEqual([
      { id: 'template-1', updatedAt: 3_000, deletedAt: 3_000 },
    ] as never)
  })

  it('takes the larger lastUsedAt from either device', async () => {
    await sync(deviceA, { version: 0, templates: [template({ lastUsedAt: 5_000 })] })
    const pushed = await sync(deviceB, {
      version: 0,
      templates: [template({ lastUsedAt: 9_000 })],
    })

    expect(pushed.body.templates).toEqual([template({ lastUsedAt: 9_000 })] as never)

    const pulledByA = await sync(deviceA, { version: 1 })
    expect(pulledByA.body.templates).toEqual([template({ lastUsedAt: 9_000 })] as never)
  })

  it('replaces the whole user settings document', async () => {
    await sync(deviceA, {
      version: 0,
      settings: { updatedAt: 1_000, document: { appMode: 'studio', pinned: ['a'] } },
    })
    const pushedB = await sync(deviceB, {
      version: 0,
      settings: { updatedAt: 2_000, document: { appMode: 'canvas' } },
    })
    expect(pushedB.body.settings).toEqual({ updatedAt: 2_000, document: { appMode: 'canvas' } })

    const older = await sync(deviceA, {
      version: 0,
      settings: { updatedAt: 1_500, document: { appMode: 'studio' } },
    })
    expect(older.body.settings).toEqual({ updatedAt: 2_000, document: { appMode: 'canvas' } })
  })

  it('hands back the records a push lost even when the client already holds the version', async () => {
    await sync(deviceA, {
      version: 0,
      templates: [template({ name: 'A', updatedAt: 2_000 })],
      settings: { updatedAt: 2_000, document: { appMode: 'studio' } },
    })
    const pulled = await sync(deviceB, { version: 0 })

    const lost = await sync(deviceB, {
      version: pulled.body.version,
      templates: [template({ name: 'B', updatedAt: 1_500 })],
      settings: { updatedAt: 1_500, document: { appMode: 'canvas' } },
    })
    expect(lost.body.version).toBe(pulled.body.version)
    expect(lost.body.templates).toEqual([template({ name: 'A', updatedAt: 2_000 })] as never)
    expect(lost.body.settings).toEqual({ updatedAt: 2_000, document: { appMode: 'studio' } })
  })

  it('leaves a tombstone untouched when the loser only carries a larger lastUsedAt', async () => {
    await sync(deviceA, { version: 0, templates: [template()] })
    const deleted = await sync(deviceA, {
      version: 1,
      templates: [{ id: 'template-1', updatedAt: 3_000, deletedAt: 3_000 }],
    })

    const lost = await sync(deviceB, {
      version: deleted.body.version,
      templates: [template({ updatedAt: 1_000, lastUsedAt: 9_000 })],
    })
    expect(lost.body.version).toBe(deleted.body.version)
    expect(lost.body.templates).toEqual([
      { id: 'template-1', updatedAt: 3_000, deletedAt: 3_000 },
    ] as never)
  })

  it('rejects a template whose params exceed the protocol budget', async () => {
    const oversized = await sync(deviceA, {
      version: 0,
      templates: [template({ params: { blob: 'x'.repeat(SYNC_TEMPLATE_PARAMS_MAX_BYTES) } })],
    })
    expect(oversized.status).toBe(400)
  })

  it('syncs assets and their tombstones', async () => {
    await uploadImage(deviceA, 'image-hash-1')
    await sync(deviceA, { version: 0, assets: [asset()] })
    const pulled = await sync(deviceB, { version: 0 })
    expect(pulled.body.assets).toEqual([asset()] as never)

    await sync(deviceA, {
      version: pulled.body.version,
      assets: [{ id: 'asset-1', updatedAt: 4_000, deletedAt: 4_000 }],
    })
    const afterDelete = await sync(deviceB, { version: pulled.body.version })
    expect(afterDelete.body.assets).toEqual([
      { id: 'asset-1', updatedAt: 4_000, deletedAt: 4_000 },
    ] as never)
  })

  it('rejects a malformed body and half-written records', async () => {
    const negativeVersion = await app.handle(
      new Request('http://localhost/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: deviceA },
        body: JSON.stringify({ version: -1 }),
      }),
    )
    expect(negativeVersion.status).toBe(400)

    const { prompt: _prompt, ...withoutPrompt } = template()
    const incomplete = await app.handle(
      new Request('http://localhost/api/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: deviceA },
        body: JSON.stringify({ version: 0, templates: [withoutPrompt] }),
      }),
    )
    expect(incomplete.status).toBe(400)

    const oversized = await sync(deviceA, {
      version: 0,
      settings: { updatedAt: 1_000, document: { blob: 'x'.repeat(SYNC_SETTINGS_MAX_BYTES) } },
    })
    expect(oversized.status).toBe(400)
  })

  it('drops every synced record when the user is deleted', async () => {
    await uploadImage(deviceA, 'image-hash-1')
    await sync(deviceA, {
      version: 0,
      templates: [template()],
      assets: [asset()],
      settings: { updatedAt: 1_000, document: { appMode: 'studio' } },
    })

    await db.delete(schema.users).where(eq(schema.users.id, 'sync-user'))

    expect(await db.select().from(schema.user_templates)).toEqual([])
    expect(await db.select().from(schema.user_assets)).toEqual([])
    expect(await db.select().from(schema.user_preferences)).toEqual([])
    expect(await db.select().from(schema.user_sync_state)).toEqual([])
  })
})
