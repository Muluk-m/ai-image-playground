import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { readUnmigratedUserAssetBytes, readUserAssetBytes } from '@image-playground/read-models'
import { and, eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

const TEST_DB = await resetTestDatabase('bff_media_ledger_unification')

process.env.PORT = '0'
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.DATABASE_URL = TEST_DB
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../projects-operator-config.json')

const { close: closeDb, db, schema } = await import('../../db/client')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
const { reserveReferenceMedia } = await import('../../lib/cli/media')
const { resolveMediaInputs } = await import('../../lib/mediaInputs')
const { accessMedia, lockMediaOwner, MediaError, mediaUsage, reclaimUnreferencedAssetMedia } =
  await import('../../lib/projectMedia')
const { serveMediaContent } = await import('../../lib/projectVideoMedia')
const { synchronize } = await import('../../lib/sync')
const { assetObjectKey, findAssetImageMeta, readAssetImage, storeAssetImage } = await import(
  '../../lib/sync-assets'
)

class DurableTestStore extends InMemoryObjectStore {
  sign(key: string, method: 'GET' | 'PUT'): string {
    return `https://durable.example.test/${method.toLowerCase()}/${key}`
  }
}

let objectStorage: InMemoryObjectStore
let durableStorage: DurableTestStore

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII=',
  'base64',
)

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

beforeEach(async () => {
  objectStorage = new InMemoryObjectStore()
  durableStorage = new DurableTestStore()
  setObjectStoreForTesting(objectStorage)
  setDurableMediaStoreForTesting(durableStorage)
  await db.delete(schema.media_references)
  await db.delete(schema.tasks)
  await db.delete(schema.users)
  await createUser('ledger-user')
})

afterEach(() => {
  setObjectStoreForTesting()
  setDurableMediaStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('unified media ledger (PR-5.4a)', () => {
  it('dual-writes asset uploads with reserved_bytes=0 without double-counting quota and rejects empty uploads', async () => {
    expect(
      await storeAssetImage('ledger-user', 'empty-img', new Uint8Array(0), 'image/png'),
    ).toEqual({ ok: false, error: 'asset_image_empty' })

    const first = await storeAssetImage('ledger-user', 'img-1', new Uint8Array(40), 'image/png')
    expect(first).toEqual({
      ok: true,
      result: { imageId: 'img-1', bytes: 40, totalBytes: 40 },
    })

    const unified = await db
      .select()
      .from(schema.media_objects)
      .where(
        and(
          eq(schema.media_objects.user_id, 'ledger-user'),
          eq(schema.media_objects.asset_image_id, 'img-1'),
        ),
      )
    expect(unified).toHaveLength(1)
    expect(unified[0]).toMatchObject({
      sha256: 'asset:img-1',
      bytes: 40,
      // Expand keeps reserved_bytes=0 so pre-5.4a containers never double-count with user_asset_objects.
      reserved_bytes: 0,
      status: 'ready',
      storage_scope: 'object',
      object_key: 'users/ledger-user/assets/img-1',
    })

    const legacy = await db
      .select()
      .from(schema.user_asset_objects)
      .where(eq(schema.user_asset_objects.user_id, 'ledger-user'))
    expect(legacy).toHaveLength(1)

    // Identical bytes under a distinct imageId must also succeed without sha256 collision.
    const second = await storeAssetImage('ledger-user', 'img-2', new Uint8Array(40), 'image/png')
    expect(second).toEqual({
      ok: true,
      result: { imageId: 'img-2', bytes: 40, totalBytes: 80 },
    })

    // Quota helpers must count each asset strictly once across both tables.
    const totalAssetBytes = await readUserAssetBytes(db, 'ledger-user')
    const unmigratedBytes = await readUnmigratedUserAssetBytes(db, 'ledger-user')
    const combinedUsage = await db.transaction(async (tx) => {
      await lockMediaOwner(tx, 'ledger-user')
      return mediaUsage(tx, 'ledger-user')
    })
    expect(totalAssetBytes).toBe(80)
    expect(unmigratedBytes).toBe(0)
    expect(combinedUsage).toBe(80)

    // mediaInputs & serveMediaContent route storage_scope='object' to objectStore(); accessMedia refuses non-durable.
    const pngUpload = await storeAssetImage('ledger-user', 'img-png', TINY_PNG, 'image/png')
    expect(pngUpload.ok).toBe(true)
    const pngMeta = await findAssetImageMeta(db, 'ledger-user', 'img-png')
    expect(pngMeta?.mediaId).toBeTruthy()
    const resolved = await resolveMediaInputs('ledger-user', [`aip-media:${pngMeta!.mediaId}`], {
      masked: false,
    })
    expect(resolved?.[0]?.startsWith('data:image/png;base64,')).toBe(true)
    const served = await serveMediaContent(
      'ledger-user',
      pngMeta!.mediaId!,
      new Request('http://localhost/media'),
    )
    expect(served.status).toBe(200)
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(new Uint8Array(TINY_PNG))
    await expect(accessMedia('ledger-user', pngMeta!.mediaId!)).rejects.toThrow(MediaError)
  })

  it('falls back to unbackfilled user_asset_objects and lazily materializes media_objects during sync', async () => {
    const now = Date.now()
    await db.insert(schema.user_asset_objects).values({
      user_id: 'ledger-user',
      image_id: 'legacy-img',
      bytes: 24,
      content_type: 'image/png',
      created_at: now,
    })
    await objectStorage.write(
      assetObjectKey('ledger-user', 'legacy-img'),
      new Uint8Array(24).fill(9),
      'image/png',
    )

    expect(await readUserAssetBytes(db, 'ledger-user')).toBe(24)
    expect(await readUnmigratedUserAssetBytes(db, 'ledger-user')).toBe(24)
    const read = await readAssetImage('ledger-user', 'legacy-img')
    expect(read?.bytes.byteLength).toBe(24)

    const synced = await synchronize('ledger-user', {
      version: 0,
      assets: [
        {
          id: 'asset-legacy',
          name: 'Legacy Asset',
          imageId: 'legacy-img',
          createdAt: now,
          updatedAt: now,
          lastUsedAt: now,
        },
      ],
    })
    expect(synced.rejected).toEqual([])

    const refs = await db
      .select()
      .from(schema.media_references)
      .where(
        and(
          eq(schema.media_references.user_id, 'ledger-user'),
          eq(schema.media_references.owner_kind, 'asset'),
          eq(schema.media_references.owner_id, 'asset-legacy'),
        ),
      )
    expect(refs).toHaveLength(1)
    expect(await readUnmigratedUserAssetBytes(db, 'ledger-user')).toBe(0)
    expect(await readUserAssetBytes(db, 'ledger-user')).toBe(24)
  })

  it('tracks asset/look media_references, refreshes grace on re-upload & legacy tombstones, and reclaims safely', async () => {
    // Upload img-1 and sibling prefix img-10, plus img-look for a look.
    await storeAssetImage('ledger-user', 'img-1', new Uint8Array(30), 'image/png')
    await storeAssetImage('ledger-user', 'img-10', new Uint8Array(30), 'image/png')
    await storeAssetImage('ledger-user', 'img-look', new Uint8Array(20), 'image/png')

    const t0 = 10_000
    const pushed = await synchronize('ledger-user', {
      version: 0,
      assets: [
        {
          id: 'asset-1',
          name: 'One',
          imageId: 'img-1',
          createdAt: t0,
          updatedAt: t0,
          lastUsedAt: t0,
        },
        {
          id: 'asset-10',
          name: 'Ten',
          imageId: 'img-10',
          createdAt: t0,
          updatedAt: t0,
          lastUsedAt: t0,
        },
      ],
      looks: [
        {
          id: 'look-1',
          name: 'Look',
          description: 'Clean',
          purpose: 'hero',
          body: 'Prompt body',
          model: 'gpt-image-2',
          size: '1024x1024',
          slotCount: 1,
          referenceImageIds: ['img-look'],
          coverImageId: 'img-look',
          createdAt: t0,
          updatedAt: t0,
          lastUsedAt: t0,
        },
      ],
    })
    expect(pushed.rejected).toEqual([])

    const refsBefore = await db
      .select({
        kind: schema.media_references.owner_kind,
        ownerId: schema.media_references.owner_id,
      })
      .from(schema.media_references)
      .where(eq(schema.media_references.user_id, 'ledger-user'))
    expect(refsBefore.sort((a, b) => a.ownerId.localeCompare(b.ownerId))).toEqual([
      { kind: 'asset', ownerId: 'asset-1' },
      { kind: 'asset', ownerId: 'asset-10' },
      { kind: 'look', ownerId: 'look-1' },
    ])

    // Live referenced images are never reclaimed even with zero grace.
    expect(await reclaimUnreferencedAssetMedia(Date.now() + 100_000, 0)).toBe(0)

    // Tombstone asset-1 and look-1; keep asset-10 alive.
    await synchronize('ledger-user', {
      version: pushed.version,
      assets: [{ id: 'asset-1', updatedAt: t0 + 1000, deletedAt: t0 + 1000 }],
      looks: [{ id: 'look-1', updatedAt: t0 + 1000, deletedAt: t0 + 1000 }],
    })

    // Inside grace period: nothing reclaimed yet.
    expect(await reclaimUnreferencedAssetMedia(Date.now(), 60_000)).toBe(0)

    // Re-uploading an old unreferenced image refreshes updated_at so it gets a fresh grace window.
    await db
      .update(schema.media_objects)
      .set({ updated_at: 1_000 })
      .where(
        and(
          eq(schema.media_objects.user_id, 'ledger-user'),
          eq(schema.media_objects.asset_image_id, 'img-1'),
        ),
      )
    expect(await storeAssetImage('ledger-user', 'img-1', new Uint8Array(30), 'image/png')).toEqual({
      ok: true,
      result: { imageId: 'img-1', bytes: 30, totalBytes: 80 },
    })
    expect(await reclaimUnreferencedAssetMedia(Date.now(), 60_000)).toBe(0)

    // After grace period: img-1 and img-look are reclaimed; sibling prefix img-10 MUST stay intact!
    const reclaimed = await reclaimUnreferencedAssetMedia(Date.now() + 120_000, 60_000)
    expect(reclaimed).toBe(2)
    expect(objectStorage.objects.has(assetObjectKey('ledger-user', 'img-1'))).toBe(false)
    expect(objectStorage.objects.has(assetObjectKey('ledger-user', 'img-look'))).toBe(false)
    expect(objectStorage.objects.has(assetObjectKey('ledger-user', 'img-10'))).toBe(true)
    expect(await readUserAssetBytes(db, 'ledger-user')).toBe(30)
    expect(
      await db
        .select({ imageId: schema.user_asset_objects.image_id })
        .from(schema.user_asset_objects)
        .where(eq(schema.user_asset_objects.user_id, 'ledger-user')),
    ).toEqual([{ imageId: 'img-10' }])
  })

  it('protects assets in production documents & pending drafts, and keeps rows ready on transient R2 delete failure', async () => {
    await storeAssetImage('ledger-user', 'img-prod', new Uint8Array(16), 'image/png')
    await storeAssetImage('ledger-user', 'img-draft', new Uint8Array(16), 'image/png')
    const now = Date.now()
    await db.insert(schema.agent_conversations).values({
      id: 'conv-prod',
      user_id: 'ledger-user',
      title: 'Prod',
      production: {
        document: {
          content: {
            locations: [{ id: 'loc', reference: { kind: 'asset', imageId: 'img-prod' } }],
          },
        },
      } as unknown as (typeof schema.agent_conversations.$inferInsert)['production'],
      created_at: now,
      updated_at: now,
    })
    await db.insert(schema.agent_generation_drafts).values({
      id: 'draft-msg-1',
      conversation_id: 'conv-prod',
      turn_id: 'turn-1',
      tool_call_id: 'call-1',
      tool_name: 'generateImage',
      media: 'image',
      provider: 'openai-compat',
      model: 'gpt-image-2',
      prompt: 'test',
      request: { prompt: 'test' },
      submission: {
        productionReferences: [{ kind: 'asset', imageId: 'img-draft' }],
      } as unknown as (typeof schema.agent_generation_drafts.$inferInsert)['submission'],
      created_at: now,
    })

    // Both production JSON and unconfirmed draft protect their assets.
    expect(await reclaimUnreferencedAssetMedia(now + 100_000, 0)).toBe(0)

    // On transient R2 delete failure, reclaim rolls back cleanly (row stays ready, never stuck in deleting).
    await storeAssetImage('ledger-user', 'img-retry', new Uint8Array(16), 'image/png')
    objectStorage.deleteFailuresRemaining = 1
    expect(await reclaimUnreferencedAssetMedia(now + 100_000, 0)).toBe(0)
    const [afterFail] = await db
      .select({ status: schema.media_objects.status })
      .from(schema.media_objects)
      .where(
        and(
          eq(schema.media_objects.user_id, 'ledger-user'),
          eq(schema.media_objects.asset_image_id, 'img-retry'),
        ),
      )
    expect(afterFail?.status).toBe('ready')

    // Next sweep succeeds cleanly even if an unrelated task is inserted mid-deleteObject.
    objectStorage.beforeDeletePrefix = async () => {
      objectStorage.beforeDeletePrefix = undefined
      await db.insert(schema.tasks).values({
        id: 'concurrent-unrelated-task',
        user_id: 'ledger-user',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'queued',
        request_payload: { prompt: 'concurrent' },
        submitted_at: Date.now(),
      })
    }
    expect(await reclaimUnreferencedAssetMedia(now + 100_000, 0)).toBe(1)
    expect(objectStorage.objects.has(assetObjectKey('ledger-user', 'img-retry'))).toBe(false)
    expect(await findAssetImageMeta(db, 'ledger-user', 'img-retry')).toBeNull()
    await db.delete(schema.tasks).where(eq(schema.tasks.id, 'concurrent-unrelated-task'))

    // If a row is explicitly marked deleting, storeAssetImage refuses concurrent PUT (409 asset_media_deleting).
    await storeAssetImage('ledger-user', 'img-del-lock', new Uint8Array(16), 'image/png')
    await db
      .update(schema.media_objects)
      .set({ status: 'deleting' })
      .where(
        and(
          eq(schema.media_objects.user_id, 'ledger-user'),
          eq(schema.media_objects.asset_image_id, 'img-del-lock'),
        ),
      )
    expect(
      await storeAssetImage('ledger-user', 'img-del-lock', new Uint8Array(16), 'image/png'),
    ).toEqual({ ok: false, error: 'asset_media_deleting' })
  })

  it('registers cli_reference in media_references when reserving CLI reference media', async () => {
    const payload = new Uint8Array(12).fill(5)
    const sha256 = createHash('sha256').update(payload).digest('hex')
    const reserved = await reserveReferenceMedia('ledger-user', {
      sha256,
      bytes: payload.byteLength,
      content_type: 'image/png',
    })
    const refs = await db
      .select()
      .from(schema.media_references)
      .where(
        and(
          eq(schema.media_references.user_id, 'ledger-user'),
          eq(schema.media_references.owner_kind, 'cli_reference'),
          eq(schema.media_references.owner_id, reserved.media_id),
          eq(schema.media_references.media_id, reserved.media_id),
        ),
      )
    expect(refs).toHaveLength(1)
  })
})
