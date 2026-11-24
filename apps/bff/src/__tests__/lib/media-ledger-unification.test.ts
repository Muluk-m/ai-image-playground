import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OAUTH_ONLY_PASSWORD_HASH } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { readUnmigratedUserAssetBytes, readUserAssetBytes } from '@image-playground/read-models'
import { and, eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

const TEST_DB = await resetTestDatabase('bff_media_ledger_unification')
const tempDir = await mkdtemp(join(tmpdir(), 'media-ledger-unification-'))
const operatorConfigPath = join(tempDir, 'operator.json')
await writeFile(
  operatorConfigPath,
  JSON.stringify({
    capabilities: {
      'accounts:login': true,
      'accounts:sync': true,
      'agent:chat': true,
      'agent:production': true,
    },
  }),
)

process.env.PORT = '0'
process.env.CORS_ALLOWED_ORIGINS = 'https://app.example.com'
process.env.DATABASE_URL = TEST_DB
process.env.OPERATOR_CONFIG_FILE = operatorConfigPath
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'

const { close: closeDb, db, schema } = await import('../../db/client')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
const { deleteOwnAccount } = await import('../../lib/account-profile')
const { reserveReferenceMedia } = await import('../../lib/cli/media')
const { resolveMediaInputs } = await import('../../lib/mediaInputs')
const {
  accessMedia,
  lockMediaOwner,
  MediaError,
  mediaUsage,
  purgeDeletingUnreferencedMedia,
  reclaimUnreferencedAssetMedia,
} = await import('../../lib/projectMedia')
const { serveMediaContent } = await import('../../lib/projectVideoMedia')
const { synchronize } = await import('../../lib/sync')
const { assetObjectKey, findAssetImageMeta, readAssetImage, storeAssetImage } = await import(
  '../../lib/sync-assets'
)
const { ProductionError, writeProduction } = await import(
  '../../modules/agent/orchestration/production/production'
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
  await rm(tempDir, { recursive: true, force: true })
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

  it('protects confirmed drafts & asset-referencing tasks, allows reclaim despite unrelated tasks, and recovers two-phase deleting rows', async () => {
    await storeAssetImage('ledger-user', 'img-prod', new Uint8Array(16), 'image/png')
    await storeAssetImage('ledger-user', 'img-draft', new Uint8Array(16), 'image/png')
    await storeAssetImage('ledger-user', 'img-confirmed-draft', new Uint8Array(16), 'image/png')
    await storeAssetImage('ledger-user', 'img-task-ref', new Uint8Array(16), 'image/png')
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
    await db.insert(schema.agent_generation_drafts).values([
      {
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
      },
      {
        id: 'draft-msg-confirmed',
        conversation_id: 'conv-prod',
        turn_id: 'turn-2',
        tool_call_id: 'call-2',
        tool_name: 'generateImage',
        media: 'image',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        prompt: 'confirmed',
        request: { prompt: 'confirmed' },
        submission: {
          productionReferences: [{ kind: 'asset', imageId: 'img-confirmed-draft' }],
        } as unknown as (typeof schema.agent_generation_drafts.$inferInsert)['submission'],
        task_id: 'confirmed-task-1',
        created_at: now,
      },
    ])
    await db.insert(schema.tasks).values([
      {
        id: 'queued-unrelated-task',
        user_id: 'ledger-user',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'queued',
        request_payload: { prompt: 'unrelated work' },
        submitted_at: now,
      },
      {
        id: 'queued-referencing-task',
        user_id: 'ledger-user',
        provider: 'openai-compat',
        model: 'gpt-image-2',
        status: 'queued',
        request_payload: {
          prompt: 'uses asset',
          input_images: [{ object: 'users/ledger-user/assets/img-task-ref', mime: 'image/png' }],
        } as unknown as (typeof schema.tasks.$inferInsert)['request_payload'],
        submitted_at: now,
      },
    ])

    // Production JSON, pending draft, confirmed draft, and task referencing img-task-ref all protect their assets.
    expect(await reclaimUnreferencedAssetMedia(now + 100_000, 0)).toBe(0)

    // An unrelated queued task must NOT block reclamation of another unreferenced asset.
    // On transient R2 delete failure, two-phase reclaim commits status='deleting' (never leaving ready with missing bytes),
    // keeps legacy bytes counted in quota, blocks concurrent PUT with 409 asset_media_deleting,
    // and purgeDeletingUnreferencedMedia finishes exact deletion cleanly on retry.
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
    expect(afterFail?.status).toBe('deleting')
    expect(await readUserAssetBytes(db, 'ledger-user')).toBe(80)
    expect(
      await storeAssetImage('ledger-user', 'img-retry', new Uint8Array(16), 'image/png'),
    ).toEqual({ ok: false, error: 'asset_media_deleting' })

    // Next deleting sweep completes exact deletion and frees the quota.
    expect(await purgeDeletingUnreferencedMedia()).toBe(1)
    expect(objectStorage.objects.has(assetObjectKey('ledger-user', 'img-retry'))).toBe(false)
    expect(await findAssetImageMeta(db, 'ledger-user', 'img-retry')).toBeNull()
    expect(await readUserAssetBytes(db, 'ledger-user')).toBe(64)

    await db.delete(schema.tasks).where(eq(schema.tasks.user_id, 'ledger-user'))
  })

  it('materializes legacy assets with fresh grace on re-upload & tombstone, serializes production vs reclaim, and handles cross-user references on account deletion', async () => {
    const oldTime = Date.now() - 48 * 60 * 60 * 1000

    // 1. Legacy-only asset > 24h old re-uploaded: materialized with fresh updated_at, not immediately reclaimed.
    await objectStorage.write(
      assetObjectKey('ledger-user', 'legacy-reupload'),
      TINY_PNG,
      'image/png',
    )
    await db.insert(schema.user_asset_objects).values({
      user_id: 'ledger-user',
      image_id: 'legacy-reupload',
      bytes: TINY_PNG.byteLength,
      content_type: 'image/png',
      created_at: oldTime,
    })
    const reuploaded = await storeAssetImage(
      'ledger-user',
      'legacy-reupload',
      TINY_PNG,
      'image/png',
    )
    expect(reuploaded.ok).toBe(true)
    expect(await reclaimUnreferencedAssetMedia(Date.now(), 60_000)).toBe(0)

    // 2. Legacy-only asset > 24h old tombstoned via sync: materialized with fresh updated_at, preserves 24h grace.
    await objectStorage.write(assetObjectKey('ledger-user', 'legacy-tomb'), TINY_PNG, 'image/png')
    await db.insert(schema.user_asset_objects).values({
      user_id: 'ledger-user',
      image_id: 'legacy-tomb',
      bytes: TINY_PNG.byteLength,
      content_type: 'image/png',
      created_at: oldTime,
    })
    await db.insert(schema.user_assets).values({
      user_id: 'ledger-user',
      id: 'asset-legacy-tomb',
      name: 'Old',
      image_id: 'legacy-tomb',
      views: [],
      created_at: oldTime,
      updated_at: oldTime,
      version: 1,
    })
    await db
      .insert(schema.user_sync_state)
      .values({ user_id: 'ledger-user', version: 1 })
      .onConflictDoNothing()
    await synchronize('ledger-user', {
      version: 1,
      assets: [{ id: 'asset-legacy-tomb', updatedAt: Date.now(), deletedAt: Date.now() }],
    })
    expect(await reclaimUnreferencedAssetMedia(Date.now(), 60_000)).toBe(0)

    // 3. Concurrent writeProduction referencing an expired unreferenced asset vs reclaimUnreferencedAssetMedia:
    // serialized by lockMediaOwner so either production keeps intact bytes OR reclaim removes it and production rejects.
    await storeAssetImage('ledger-user', 'img-race-prod', TINY_PNG, 'image/png')
    await db
      .update(schema.media_objects)
      .set({ updated_at: oldTime })
      .where(
        and(
          eq(schema.media_objects.user_id, 'ledger-user'),
          eq(schema.media_objects.asset_image_id, 'img-race-prod'),
        ),
      )
    await db.insert(schema.agent_conversations).values({
      id: 'conv-race',
      user_id: 'ledger-user',
      title: 'Race',
      created_at: oldTime,
      updated_at: oldTime,
    })
    const [prodOutcome, reclaimOutcome] = await Promise.allSettled([
      writeProduction(
        'conv-race',
        'ledger-user',
        {
          operationId: 'op-race-1',
          baseRevision: 0,
          content: {
            title: 'Race',
            setting: 'Studio',
            outline: 'Race test',
            characters: [],
            locations: [
              {
                id: 'loc-race',
                name: 'Hall',
                description: 'Main hall',
                reference: { kind: 'asset', imageId: 'img-race-prod' },
              },
            ],
            scenes: [],
          },
        },
        'user',
      ),
      reclaimUnreferencedAssetMedia(Date.now(), 60_000),
    ])
    if (prodOutcome.status === 'fulfilled') {
      // Production won: object bytes and ready row must remain intact.
      expect(objectStorage.objects.has(assetObjectKey('ledger-user', 'img-race-prod'))).toBe(true)
      expect(await findAssetImageMeta(db, 'ledger-user', 'img-race-prod')).not.toBeNull()
    } else {
      // Reclaim won: production must reject cleanly with production_invalid, and bytes are deleted.
      expect(prodOutcome.reason).toBeInstanceOf(ProductionError)
      expect((prodOutcome.reason as InstanceType<typeof ProductionError>).code).toBe(
        'production_invalid',
      )
      expect(reclaimOutcome.status).toBe('fulfilled')
      expect(objectStorage.objects.has(assetObjectKey('ledger-user', 'img-race-prod'))).toBe(false)
    }

    // 4. Cross-user media_references pointing to ledger-user's media_objects must not block account deletion.
    await createUser('other-user')
    await storeAssetImage('ledger-user', 'img-cross-ref', TINY_PNG, 'image/png')
    const [crossMedia] = await db
      .select({ id: schema.media_objects.id })
      .from(schema.media_objects)
      .where(
        and(
          eq(schema.media_objects.user_id, 'ledger-user'),
          eq(schema.media_objects.asset_image_id, 'img-cross-ref'),
        ),
      )
    await db.insert(schema.media_references).values({
      user_id: 'other-user',
      media_id: crossMedia!.id,
      owner_kind: 'asset',
      owner_id: 'dirty-cross-ref',
      created_at: Date.now(),
    })
    await db
      .update(schema.users)
      .set({ password_hash: OAUTH_ONLY_PASSWORD_HASH })
      .where(eq(schema.users.id, 'ledger-user'))
    await expect(deleteOwnAccount('ledger-user', undefined)).resolves.toBeUndefined()
  })

  it('rejects historical zero-byte user_asset_objects rows during sync as asset_image_missing', async () => {
    const now = Date.now()
    await db.insert(schema.user_asset_objects).values({
      user_id: 'ledger-user',
      image_id: 'legacy-zero-byte',
      bytes: 0,
      content_type: 'image/png',
      created_at: now,
    })
    const res = await synchronize('ledger-user', {
      version: 0,
      assets: [
        {
          id: 'asset-zero',
          name: 'Corrupt',
          imageId: 'legacy-zero-byte',
          createdAt: now,
          updatedAt: now,
          lastUsedAt: now,
        },
      ],
    })
    expect(res.rejected).toEqual([
      { collection: 'assets', id: 'asset-zero', reason: 'asset_image_missing' },
    ])
  })

  it('prevents old-BFF sync binding and protects re-uploaded bytes when purgeDeletingUnreferencedMedia interleaves after claim', async () => {
    const oldBytes = new Uint8Array([1, 2, 3, 4])
    const newBytes = new Uint8Array([9, 8, 7, 6, 5])
    await storeAssetImage('ledger-user', 'img-interleave', oldBytes, 'image/png')
    const oldTime = Date.now() - 48 * 60 * 60 * 1000
    await db
      .update(schema.media_objects)
      .set({ updated_at: oldTime })
      .where(
        and(
          eq(schema.media_objects.user_id, 'ledger-user'),
          eq(schema.media_objects.asset_image_id, 'img-interleave'),
        ),
      )

    let claimedMediaId: string | null = null
    let legacyVisibleAfterClaim = -1
    const reclaimed = await reclaimUnreferencedAssetMedia(Date.now(), 60_000, undefined, {
      afterClaim: async (mediaId) => {
        claimedMediaId = mediaId
        // 1. Legacy user_asset_objects row was already removed in the claim tx under user_sync_state lock,
        // so a pre-5.4a BFF POST /api/sync cannot see or bind img-interleave during the deleting window.
        const legacyRows = await db
          .select({ imageId: schema.user_asset_objects.image_id })
          .from(schema.user_asset_objects)
          .where(
            and(
              eq(schema.user_asset_objects.user_id, 'ledger-user'),
              eq(schema.user_asset_objects.image_id, 'img-interleave'),
            ),
          )
        legacyVisibleAfterClaim = legacyRows.length

        // 2. Another sweeper finishes deleting the claimed row and its bytes.
        expect(await purgeDeletingUnreferencedMedia()).toBe(1)
        expect(objectStorage.objects.has(assetObjectKey('ledger-user', 'img-interleave'))).toBe(
          false,
        )

        // 3. The user re-uploads the exact same imageId (new media_objects.id, same deterministic R2 key).
        const reuploaded = await storeAssetImage(
          'ledger-user',
          'img-interleave',
          newBytes,
          'image/png',
        )
        expect(reuploaded.ok).toBe(true)
      },
    })

    // The paused reclaimer resumes for the obsolete claimedMediaId and MUST NOT delete the newly uploaded bytes.
    expect(claimedMediaId).not.toBeNull()
    expect(legacyVisibleAfterClaim).toBe(0)
    expect(reclaimed).toBe(0)
    expect(await objectStorage.read(assetObjectKey('ledger-user', 'img-interleave'))).toEqual(
      newBytes,
    )
    const activeMeta = await findAssetImageMeta(db, 'ledger-user', 'img-interleave')
    expect(activeMeta).not.toBeNull()
    expect(activeMeta?.bytes).toBe(newBytes.byteLength)
    expect(activeMeta?.mediaId).not.toBe(claimedMediaId)
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
