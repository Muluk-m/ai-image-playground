import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { SyncRequestBody, SyncResponseBody } from '@image-playground/shared'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

const TEST_DB = await resetTestDatabase('bff_sync_assets')

process.env.PORT = '0'
process.env.DATABASE_URL = TEST_DB
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../sync-assets-operator-config.json')

// Dynamic imports keep environment setup ahead of configuration capture.
const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')

const IMAGE_BYTES_LIMIT = 64
const USER_BYTES_LIMIT = 160

let storage: InMemoryObjectStore

beforeEach(() => {
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
})

afterEach(() => {
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

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
  const token = await db.transaction((tx) => createUserSession(id, tx))
  return `${USER_SESSION_COOKIE}=${token}`
}

function bytes(size: number, fill = 7): Uint8Array<ArrayBuffer> {
  const value = new Uint8Array(size)
  value.fill(fill)
  return value
}

async function upload(
  cookie: string | null,
  imageId: string,
  body: Uint8Array<ArrayBuffer>,
  contentType = 'image/png',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': contentType }
  if (cookie) headers.cookie = cookie
  const response = await app.handle(
    new Request(`http://localhost/api/sync/assets/${imageId}`, {
      method: 'PUT',
      headers,
      body,
    }),
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

async function download(cookie: string | null, imageId: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (cookie) headers.cookie = cookie
  return app.handle(
    new Request(`http://localhost/api/sync/assets/${imageId}`, { method: 'GET', headers }),
  )
}

async function sync(
  cookie: string,
  body: SyncRequestBody,
): Promise<{ status: number; body: SyncResponseBody }> {
  const response = await app.handle(
    new Request('http://localhost/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, body: (await response.json()) as SyncResponseBody }
}

describe('sync asset images', () => {
  let owner: string

  beforeEach(async () => {
    await db.delete(schema.users)
    owner = await createUser('asset-owner')
  })

  it('rejects anonymous upload and download', async () => {
    expect((await upload(null, 'image-1', bytes(8))).status).toBe(401)
    expect((await download(null, 'image-1')).status).toBe(401)
  })

  it('stores an image under the owner key and hands it back', async () => {
    const stored = await upload(owner, 'image-1', bytes(8))
    expect(stored.status).toBe(200)
    expect(stored.body).toEqual({ imageId: 'image-1', bytes: 8, totalBytes: 8 })
    expect(storage.objects.has('users/asset-owner/assets/image-1')).toBe(true)

    const fetched = await download(owner, 'image-1')
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(bytes(8))
  })

  it('accepts a repeat upload of the same imageId without counting it twice', async () => {
    await upload(owner, 'image-1', bytes(8))
    const again = await upload(owner, 'image-1', bytes(8))

    expect(again.status).toBe(200)
    expect(again.body).toEqual({ imageId: 'image-1', bytes: 8, totalBytes: 8 })
    expect(storage.events.filter((event) => event.startsWith('write:'))).toHaveLength(1)
  })

  it('rejects an image over the per-image limit', async () => {
    const oversized = await upload(owner, 'image-1', bytes(IMAGE_BYTES_LIMIT + 1))

    expect(oversized.status).toBe(413)
    expect(oversized.body).toEqual({
      error: 'asset_image_too_large',
      limit: IMAGE_BYTES_LIMIT,
    })
    expect(storage.objects.size).toBe(0)
  })

  it('rejects an image that would push the user over the storage limit', async () => {
    await upload(owner, 'image-1', bytes(IMAGE_BYTES_LIMIT))
    await upload(owner, 'image-2', bytes(IMAGE_BYTES_LIMIT))
    const overflowing = await upload(owner, 'image-3', bytes(IMAGE_BYTES_LIMIT))

    expect(overflowing.status).toBe(413)
    expect(overflowing.body).toEqual({
      error: 'asset_storage_quota_exceeded',
      limit: USER_BYTES_LIMIT,
    })
    expect(storage.objects.has('users/asset-owner/assets/image-3')).toBe(false)
  })

  it('rejects an unsupported media type and a malformed imageId', async () => {
    const wrongType = await upload(owner, 'image-1', bytes(8), 'application/pdf')
    expect(wrongType.status).toBe(415)
    expect(wrongType.body).toEqual({ error: 'unsupported_media_type' })

    const traversal = await upload(owner, '..%2Fescape', bytes(8))
    expect(traversal.status).toBe(400)
    expect(storage.objects.size).toBe(0)
  })

  it('keeps one user out of another user image', async () => {
    const other = await createUser('other-user')
    await upload(owner, 'image-1', bytes(8))

    expect((await download(other, 'image-1')).status).toBe(404)
    expect((await download(owner, 'missing-image')).status).toBe(404)
  })

  it('rejects an asset record whose image was never uploaded and keeps the batch', async () => {
    await upload(owner, 'image-1', bytes(8))

    const pushed = await sync(owner, {
      version: 0,
      templates: [
        {
          id: 'template-1',
          name: 'Studio shot',
          prompt: 'a cat',
          assetIds: [],
          params: {},
          createdAt: 1_000,
          updatedAt: 1_000,
          lastUsedAt: 1_000,
        },
      ],
      assets: [
        {
          id: 'asset-1',
          name: 'Uploaded',
          imageId: 'image-1',
          createdAt: 1_000,
          updatedAt: 1_000,
          lastUsedAt: 1_000,
        },
        {
          id: 'asset-2',
          name: 'Missing image',
          imageId: 'image-missing',
          createdAt: 1_000,
          updatedAt: 1_000,
          lastUsedAt: 1_000,
        },
      ],
    })

    expect(pushed.status).toBe(200)
    expect(pushed.body.rejected).toEqual([
      { collection: 'assets', id: 'asset-2', reason: 'asset_image_missing' },
    ])
    expect(pushed.body.templates).toHaveLength(1)
    expect(pushed.body.assets.map((change) => change.id)).toEqual(['asset-1'])
  })

  it('accepts an asset tombstone without requiring the image', async () => {
    const pushed = await sync(owner, {
      version: 0,
      assets: [{ id: 'asset-1', updatedAt: 2_000, deletedAt: 2_000 }],
    })

    expect(pushed.body.rejected).toEqual([])
    expect(pushed.body.assets).toEqual([{ id: 'asset-1', updatedAt: 2_000, deletedAt: 2_000 }])
  })

  it('drops the ledger rows when the user is deleted', async () => {
    await upload(owner, 'image-1', bytes(8))
    await db.delete(schema.users)

    expect(await db.select().from(schema.user_asset_objects)).toEqual([])
  })
})
