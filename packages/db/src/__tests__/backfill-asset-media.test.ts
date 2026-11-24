import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { backfillAssetMedia, verifyAssetMediaConsistency } from '../backfill-asset-media'
import { createDb } from '../client'
import { resetTestDatabase } from '../testing'

const databaseUrl = await resetTestDatabase('db_backfill_asset_media')
const connection = createDb(databaseUrl)

beforeEach(async () => {
  await connection.client`DELETE FROM media_references`
  await connection.client`DELETE FROM cli_reference_media`
  await connection.client`DELETE FROM media_objects`
  await connection.client`DELETE FROM user_assets`
  await connection.client`DELETE FROM user_looks`
  await connection.client`DELETE FROM user_asset_objects`
  await connection.client`DELETE FROM users`
})

afterAll(async () => {
  await connection.close()
})

describe('backfillAssetMedia & verifyAssetMediaConsistency', () => {
  it('zero-copy backfills legacy assets, live asset/look refs, and CLI refs in batches idempotently', async () => {
    const now = new Date('2026-11-24T00:00:00.000Z')
    await connection.client`
      INSERT INTO users (id, username, password_hash, status, created_at, updated_at)
      VALUES
        ('u1', 'u1', 'hash', 'active', ${now}, ${now}),
        ('u2', 'u2', 'hash', 'active', ${now}, ${now})
    `
    await connection.client`
      INSERT INTO user_asset_objects (user_id, image_id, bytes, content_type, created_at)
      VALUES
        ('u1', 'img-1', 100, 'image/png', ${now}),
        ('u1', 'img-2', 200, 'image/jpeg', ${now}),
        ('u1', 'img-3', 300, 'image/webp', ${now}),
        ('u1', 'img-orphan', 50, 'image/png', ${now}),
        ('u1', 'img-zero-corrupt', 0, 'image/png', ${now}),
        ('u2', 'img-1', 120, 'image/png', ${now})
    `
    // Live asset referencing img-1 (cover) + img-2 (view), plus a tombstoned asset.
    await connection.client`
      INSERT INTO user_assets (user_id, id, name, image_id, views, created_at, updated_at, deleted_at, version)
      VALUES
        (
          'u1', 'asset-live', 'Bottle', 'img-1',
          '[{"imageId":"img-1","label":"front","source":"upload"},{"imageId":"img-2","label":"back","source":"upload"}]'::jsonb,
          ${now}, ${now}, NULL, 1
        ),
        (
          'u1', 'asset-dead', NULL, NULL, NULL,
          NULL, ${now}, ${now}, 2
        )
    `
    // Live look referencing cover img-3 + ref img-1, plus a tombstoned look.
    await connection.client`
      INSERT INTO user_looks (
        user_id, id, name, description, purpose, body, model, size, slot_count,
        reference_image_ids, cover_image_id, created_at, updated_at, deleted_at, version
      )
      VALUES
        (
          'u1', 'look-live', 'Studio', 'Clean look', 'hero', 'body', 'gpt-image-2', '1024x1024', 1,
          '["img-1","img-3"]'::jsonb, 'img-3', ${now}, ${now}, NULL, 3
        ),
        (
          'u1', 'look-dead', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          NULL, NULL, NULL, ${now}, ${now}, 4
        )
    `
    // Durable CLI reference media without a media_references row yet.
    await connection.client`
      INSERT INTO media_objects (
        id, user_id, sha256, bytes, content_type, status, attachment_managed,
        reserved_bytes, staging_key, object_key, preview_key, preview_bytes,
        storage_scope, expires_at, created_at, updated_at
      )
      VALUES (
        'cli-media-1', 'u1', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        512, 'image/png', 'ready', false,
        512, 'staging/u1/1', 'objects/u1/cli-media-1/original', 'objects/u1/cli-media-1/preview.webp', 0,
        'durable', ${now}, ${now}, ${now}
      )
    `
    await connection.client`
      INSERT INTO cli_reference_media (media_id, user_id, created_at)
      VALUES ('cli-media-1', 'u1', ${now})
    `

    const before = await verifyAssetMediaConsistency(connection.client)
    expect(before).toEqual({
      totalLegacyAssets: 5,
      totalUnifiedAssetMedia: 0,
      missingAssetMediaCount: 5,
      missingAssetRefCount: 2,
      missingLookRefCount: 2,
      missingCliRefCount: 1,
      staleSyncedRefCount: 0,
      sampleMissingAssetImages: ['u1:img-1', 'u1:img-2', 'u1:img-3', 'u1:img-orphan', 'u2:img-1'],
    })

    const phases: string[] = []
    const firstRun = await backfillAssetMedia(connection.client, {
      batchSize: 2,
      delayMs: 0,
      onBatch: (batch) => phases.push(batch.phase),
    })
    expect(firstRun.completed).toBe(true)
    expect(firstRun.objectsScanned).toBe(5)
    expect(firstRun.objectsWritten).toBe(5)
    expect(firstRun.assetRefsScanned).toBe(1)
    expect(firstRun.assetRefsWritten).toBe(2)
    expect(firstRun.lookRefsScanned).toBe(1)
    expect(firstRun.lookRefsWritten).toBe(2)
    expect(firstRun.cliRefsScanned).toBe(1)
    expect(firstRun.cliRefsWritten).toBe(1)
    expect(firstRun.staleRefsPruned).toBe(0)
    expect(phases).toContain('objects')
    expect(phases).toContain('asset_refs')
    expect(phases).toContain('look_refs')
    expect(phases).toContain('cli_refs')

    // Zero-copy & rolling-deploy invariants: reserved_bytes = 0 (pre-5.4a BFF won't double-count),
    // object_key points directly to legacy users/<uid>/assets/<imageId>, storage_scope = 'object'.
    const unifiedRows = await connection.client<
      {
        user_id: string
        asset_image_id: string
        sha256: string
        object_key: string
        storage_scope: string
        status: string
        bytes: string
        reserved_bytes: string
      }[]
    >`
      SELECT user_id, asset_image_id, sha256, object_key, storage_scope, status, bytes::text, reserved_bytes::text
      FROM media_objects
      WHERE asset_image_id IS NOT NULL
      ORDER BY user_id ASC, asset_image_id ASC
    `
    expect(unifiedRows).toEqual([
      {
        user_id: 'u1',
        asset_image_id: 'img-1',
        sha256: 'asset:img-1',
        object_key: 'users/u1/assets/img-1',
        storage_scope: 'object',
        status: 'ready',
        bytes: '100',
        reserved_bytes: '0',
      },
      {
        user_id: 'u1',
        asset_image_id: 'img-2',
        sha256: 'asset:img-2',
        object_key: 'users/u1/assets/img-2',
        storage_scope: 'object',
        status: 'ready',
        bytes: '200',
        reserved_bytes: '0',
      },
      {
        user_id: 'u1',
        asset_image_id: 'img-3',
        sha256: 'asset:img-3',
        object_key: 'users/u1/assets/img-3',
        storage_scope: 'object',
        status: 'ready',
        bytes: '300',
        reserved_bytes: '0',
      },
      {
        user_id: 'u1',
        asset_image_id: 'img-orphan',
        sha256: 'asset:img-orphan',
        object_key: 'users/u1/assets/img-orphan',
        storage_scope: 'object',
        status: 'ready',
        bytes: '50',
        reserved_bytes: '0',
      },
      {
        user_id: 'u2',
        asset_image_id: 'img-1',
        sha256: 'asset:img-1',
        object_key: 'users/u2/assets/img-1',
        storage_scope: 'object',
        status: 'ready',
        bytes: '120',
        reserved_bytes: '0',
      },
    ])

    const after = await verifyAssetMediaConsistency(connection.client)
    expect(after).toEqual({
      totalLegacyAssets: 5,
      totalUnifiedAssetMedia: 5,
      missingAssetMediaCount: 0,
      missingAssetRefCount: 0,
      missingLookRefCount: 0,
      missingCliRefCount: 0,
      staleSyncedRefCount: 0,
      sampleMissingAssetImages: [],
    })

    // Re-running must be strictly idempotent (zero new writes, zero scanned).
    const replay = await backfillAssetMedia(connection.client, { batchSize: 2, delayMs: 0 })
    expect(replay.completed).toBe(true)
    expect(replay.batches).toBe(0)
    expect(replay.objectsWritten).toBe(0)
    expect(replay.assetRefsWritten).toBe(0)
    expect(replay.lookRefsWritten).toBe(0)
    expect(replay.cliRefsWritten).toBe(0)
    expect(replay.staleRefsPruned).toBe(0)

    // Simulate a stale media_reference left behind by a concurrent tombstone during online backfill.
    await connection.client`
      UPDATE user_assets
      SET deleted_at = ${now}, name = NULL, image_id = NULL, views = NULL, created_at = NULL
      WHERE user_id = 'u1' AND id = 'asset-live'
    `
    const drifted = await verifyAssetMediaConsistency(connection.client)
    expect(drifted.staleSyncedRefCount).toBe(2)

    const repaired = await backfillAssetMedia(connection.client, { batchSize: 2, delayMs: 0 })
    expect(repaired.completed).toBe(true)
    expect(repaired.staleRefsPruned).toBe(2)
    expect((await verifyAssetMediaConsistency(connection.client)).staleSyncedRefCount).toBe(0)
  })

  it('advances monotonically across repeated bounded maxBatches slices', async () => {
    const now = new Date('2026-11-24T00:00:00.000Z')
    await connection.client`
      INSERT INTO users (id, username, password_hash, status, created_at, updated_at)
      VALUES ('u-slice', 'u-slice', 'hash', 'active', ${now}, ${now})
    `
    await connection.client`
      INSERT INTO user_asset_objects (user_id, image_id, bytes, content_type, created_at)
      VALUES
        ('u-slice', 'a1', 10, 'image/png', ${now}),
        ('u-slice', 'a2', 10, 'image/png', ${now}),
        ('u-slice', 'a3', 10, 'image/png', ${now})
    `
    const slice1 = await backfillAssetMedia(connection.client, {
      batchSize: 1,
      delayMs: 0,
      maxBatches: 1,
    })
    expect(slice1.completed).toBe(false)
    expect(slice1.objectsWritten).toBe(1)

    // Re-running with the EXACT same maxBatches=1 must advance to the second unmigrated row.
    const slice2 = await backfillAssetMedia(connection.client, {
      batchSize: 1,
      delayMs: 0,
      maxBatches: 1,
    })
    expect(slice2.completed).toBe(false)
    expect(slice2.objectsWritten).toBe(1)

    const slice3 = await backfillAssetMedia(connection.client, {
      batchSize: 1,
      delayMs: 0,
      maxBatches: 1,
    })
    expect(slice3.completed).toBe(false)
    expect(slice3.objectsWritten).toBe(1)

    const finalPass = await backfillAssetMedia(connection.client, {
      batchSize: 1,
      delayMs: 0,
      maxBatches: 1,
    })
    expect(finalPass.completed).toBe(true)
    expect(finalPass.objectsWritten).toBe(0)

    const report = await verifyAssetMediaConsistency(connection.client)
    expect(report.missingAssetMediaCount).toBe(0)
  })

  it('starts a fresh updated_at grace window on backfill while preserving created_at, and bounds stale ref pruning per user to batchSize', async () => {
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000)
    const beforeBackfill = Date.now() - 5_000
    await connection.client`
      INSERT INTO users (id, username, password_hash, status, created_at, updated_at)
      VALUES ('u-heavy', 'u-heavy', 'hash', 'active', ${oldTime}, ${oldTime})
    `
    for (let i = 1; i <= 5; i++) {
      await connection.client`
        INSERT INTO user_asset_objects (user_id, image_id, bytes, content_type, created_at)
        VALUES ('u-heavy', ${`old-img-${i}`}, 100, 'image/png', ${oldTime})
      `
      await connection.client`
        INSERT INTO user_assets (user_id, id, name, image_id, views, created_at, updated_at, version)
        VALUES ('u-heavy', ${`heavy-asset-${i}`}, ${`Asset ${i}`}, ${`old-img-${i}`}, '[]'::jsonb, ${oldTime}, ${oldTime}, ${i})
      `
    }

    const first = await backfillAssetMedia(connection.client, { batchSize: 10, delayMs: 0 })
    expect(first.completed).toBe(true)
    expect(first.objectsWritten).toBe(5)
    expect(first.assetRefsWritten).toBe(5)

    // Backfilled rows preserve historical created_at while initializing updated_at to backfill time.
    const timestamps = await connection.client<
      { asset_image_id: string; created_ms: string; updated_ms: string }[]
    >`
      SELECT
        asset_image_id,
        (EXTRACT(EPOCH FROM created_at) * 1000)::bigint::text AS created_ms,
        (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint::text AS updated_ms
      FROM media_objects
      WHERE user_id = 'u-heavy'
      ORDER BY asset_image_id ASC
    `
    expect(timestamps).toHaveLength(5)
    for (const row of timestamps) {
      expect(Number(row.created_ms)).toBeLessThan(beforeBackfill - 24 * 60 * 60 * 1000)
      expect(Number(row.updated_ms)).toBeGreaterThanOrEqual(beforeBackfill)
    }

    // Tombstone all 5 assets directly (simulating stale refs from concurrent tombstones)
    // and prune with batchSize=2, maxBatches=1: each slice must prune at most 2 rows and never skip the rest.
    await connection.client`
      UPDATE user_assets
      SET deleted_at = NOW(), name = NULL, image_id = NULL, views = NULL, created_at = NULL
      WHERE user_id = 'u-heavy'
    `
    expect((await verifyAssetMediaConsistency(connection.client)).staleSyncedRefCount).toBe(5)

    const p1 = await backfillAssetMedia(connection.client, {
      batchSize: 2,
      delayMs: 0,
      maxBatches: 1,
    })
    expect(p1.staleRefsPruned).toBe(2)
    expect(p1.completed).toBe(false)

    const p2 = await backfillAssetMedia(connection.client, {
      batchSize: 2,
      delayMs: 0,
      maxBatches: 1,
    })
    expect(p2.staleRefsPruned).toBe(2)
    expect(p2.completed).toBe(false)

    const p3 = await backfillAssetMedia(connection.client, {
      batchSize: 2,
      delayMs: 0,
      maxBatches: 1,
    })
    expect(p3.staleRefsPruned).toBe(1)
    expect(p3.completed).toBe(true)

    expect((await verifyAssetMediaConsistency(connection.client)).staleSyncedRefCount).toBe(0)
  })

  it('reports drift when a live asset or look only has a deleting media_objects row without references', async () => {
    const now = new Date('2026-11-24T00:00:00.000Z')
    await connection.client`
      INSERT INTO users (id, username, password_hash, status, created_at, updated_at)
      VALUES ('u-drift', 'u-drift', 'hash', 'active', ${now}, ${now})
    `
    await connection.client`
      INSERT INTO user_asset_objects (user_id, image_id, bytes, content_type, created_at)
      VALUES ('u-drift', 'img-deleting', 120, 'image/png', ${now})
    `
    await connection.client`
      INSERT INTO media_objects (
        id, user_id, sha256, bytes, content_type, status, attachment_managed,
        reserved_bytes, staging_key, object_key, preview_key, preview_bytes,
        asset_image_id, storage_scope, expires_at, created_at, updated_at
      )
      VALUES (
        'media-deleting-1', 'u-drift', 'asset:img-deleting', 120, 'image/png', 'deleting', false,
        0, 'users/u-drift/assets/img-deleting', 'users/u-drift/assets/img-deleting', NULL, 0,
        'img-deleting', 'object', ${now}, ${now}, ${now}
      )
    `
    await connection.client`
      INSERT INTO user_assets (user_id, id, name, image_id, views, created_at, updated_at, version)
      VALUES ('u-drift', 'asset-deleting', 'Broken', 'img-deleting', '[]'::jsonb, ${now}, ${now}, 1)
    `
    await connection.client`
      INSERT INTO user_looks (
        user_id, id, name, description, purpose, body, model, size, slot_count,
        reference_image_ids, cover_image_id, created_at, updated_at, version
      )
      VALUES (
        'u-drift', 'look-deleting', 'Broken Look', 'd', 'hero', 'b', 'gpt-image-2', '1024x1024', 1,
        '["img-deleting"]'::jsonb, 'img-deleting', ${now}, ${now}, 2
      )
    `
    const report = await verifyAssetMediaConsistency(connection.client)
    expect(report.missingAssetMediaCount).toBe(1)
    expect(report.missingAssetRefCount).toBe(1)
    expect(report.missingLookRefCount).toBe(1)
    expect(report.sampleMissingAssetImages).toEqual(['u-drift:img-deleting'])
  })
})
