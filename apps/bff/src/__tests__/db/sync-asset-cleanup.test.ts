import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.DATABASE_URL = await resetTestDatabase('bff_sync_asset_cleanup')
process.env.PORT = '0'
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { close: closeDb, db, schema } = await import('../../db/client')
const { purgeOrphanedAssetObjects } = await import('../../db/maintenance')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')

let storage: InMemoryObjectStore

beforeEach(async () => {
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
  await db.delete(schema.users)
})

afterEach(() => {
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

async function createUser(id: string): Promise<void> {
  const now = Date.now()
  await db.insert(schema.users).values({
    id,
    username: id,
    password_hash: 'fixture-hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
}

async function storeObject(userId: string, imageId: string): Promise<void> {
  await storage.write(`users/${userId}/assets/${imageId}`, new Uint8Array(4), 'image/png')
}

describe('purgeOrphanedAssetObjects', () => {
  it('removes the objects of deleted users and keeps the rest', async () => {
    await createUser('alive-user')
    await storeObject('alive-user', 'image-1')
    await storeObject('deleted-user', 'image-2')

    expect(await purgeOrphanedAssetObjects()).toBe(1)
    expect([...storage.objects.keys()]).toEqual(['users/alive-user/assets/image-1'])
  })

  it('does nothing when every owner still exists', async () => {
    await createUser('alive-user')
    await storeObject('alive-user', 'image-1')

    expect(await purgeOrphanedAssetObjects()).toBe(0)
    expect(storage.objects.size).toBe(1)
  })
})
