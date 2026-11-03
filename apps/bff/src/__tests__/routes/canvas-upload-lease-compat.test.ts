import { afterAll, beforeAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  CANVAS_UPLOAD_DEVICE_META,
  CANVAS_UPLOAD_STALE_MS,
  CANVAS_UPLOAD_STARTED_META,
  canvasOrigin,
  insertCanvasNode,
  moveCanvasNodes,
  readCanvasDocument,
} from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import * as Y from 'yjs'

process.env.DATABASE_URL = await resetTestDatabase('canvas_lease_compat')
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../canvas-sync-operator-config.json')
process.env.PORT = '0'
const { app } = await import('../../app')
const { startHttpServer } = await import('../../lib/httpServer')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
let cookie: string
let base: string
const origin = canvasOrigin('user', 'test')

beforeAll(async () => {
  const now = Date.now()
  for (const id of ['owner'])
    await db.insert(schema.users).values({
      id,
      username: id,
      password_hash: 'unused',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('owner', tx))}`
  startHttpServer(app, { port: 0, hostname: '127.0.0.1' })
  base = `http://127.0.0.1:${app.server!.port}`
})
afterAll(async () => {
  const { canvasSyncRooms } = await import('../../lib/canvasSyncRooms')
  await canvasSyncRooms.close()
  await app.server!.stop(true)
  await close()
}, 15_000)

async function readyMedia(id: string) {
  const now = Date.now()
  await db.insert(schema.media_objects).values({
    id,
    user_id: 'owner',
    sha256: id,
    bytes: 1,
    content_type: 'image/png',
    status: 'ready',
    reserved_bytes: 1,
    staging_key: id,
    object_key: id,
    expires_at: now + 86_400_000,
    created_at: now,
    updated_at: now,
  })
}

async function canvasOf(id: string, session = cookie) {
  const response = await fetch(`${base}/api/projects/${id}/canvas`, {
    headers: { cookie: session },
  })
  expect(response.status).toBe(200)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()))
  return doc
}

import {
  canvasUploadingElsewhere,
  canvasUploadLeaseTime,
  canvasUploadNodeKey,
  claimCanvasUpload,
  CANVAS_UPLOAD_STALE_MS as LEASE_TTL,
  promoteCanvasResultMedia,
  releaseCanvasUploadClaim,
  updateCanvasNode,
  watchCanvasUploadConflicts,
} from '@image-playground/shared'
import { watchCanvasUploadConflicts as watchLegacy } from '../../../../../packages/shared/src/__tests__/fixtures/legacy-canvas-upload-conflicts'

const network = canvasOrigin('system', 'lease-network')
const imageData = (doc: Y.Doc) =>
  readCanvasDocument(doc).nodes.find((n) => n.type === 'image')!.data
const state = (data: ReturnType<typeof imageData>) => ({
  device: data.meta?.uploadDevice,
  stamp: data.meta?.uploadStartedAt,
  at: data.meta?.uploadLeaseAt,
  binding: data.meta?.uploadLeaseFor,
})
const applyData = (doc: Y.Doc, data: ReturnType<typeof imageData>) =>
  updateCanvasNode(doc, 'photo', { data }, origin)
async function sourceFixture() {
  const { accessCanvasDocument } = await import('../../lib/canvasSyncStore')
  const id = crypto.randomUUID()
  expect(
    (
      await fetch(`${base}/api/projects/${id}`, {
        method: 'PUT',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          baseRevision: 0,
          name: 'Lease compatibility',
          document: { version: 1, experience: 'canvas', elements: [] },
        }),
      })
    ).status,
  ).toBe(200)
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await accessCanvasDocument('owner', id))
  const vector = Y.encodeStateVector(doc)
  insertCanvasNode(
    doc,
    {
      id: 'photo',
      type: 'image',
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      data: {
        fileId: 'original',
        name: 'photo',
        meta: { uploadDevice: 'fast', uploadStartedAt: String(Date.now() + 60 * 60_000) },
      },
    },
    origin,
  )
  await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc, vector))
  doc.destroy()
  return id
}
for (const [newId, oldId] of [
  [1, 2],
  [2, 1],
])
  for (const first of ['new', 'old'])
    it(`legacy repair after ack cannot erase a lease (${newId}/${oldId}, ${first} first)`, async () => {
      const { accessCanvasDocument } = await import('../../lib/canvasSyncStore')
      const id = await sourceFixture(),
        seed = await accessCanvasDocument('owner', id)
      const fresh = new Y.Doc(),
        old = new Y.Doc()
      Y.applyUpdate(fresh, seed)
      Y.applyUpdate(old, seed)
      fresh.clientID = newId!
      old.clientID = oldId!
      const stopNew = watchCanvasUploadConflicts(fresh, (o) => o === network, origin),
        stopOld = watchLegacy(old, (o) => o === network, origin)
      const send = async (doc: Y.Doc) =>
        accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc))
      try {
        const before = Y.encodeStateVector(fresh),
          now = Date.now()
        applyData(fresh, {
          ...imageData(fresh),
          meta: claimCanvasUpload(
            imageData(fresh),
            'fresh-device',
            now,
            canvasUploadNodeKey(fresh, 'photo'),
          ),
        })
        applyData(old, { ...imageData(old), name: 'renamed-by-old' })
        const newPacket = Y.encodeStateAsUpdate(fresh, before),
          oldPacket = Y.encodeStateAsUpdate(old, before)
        for (const packet of first === 'new' ? [newPacket, oldPacket] : [oldPacket, newPacket])
          await accessCanvasDocument('owner', id, packet)
        const canonical = await accessCanvasDocument('owner', id)
        Y.applyUpdate(fresh, oldPacket, network)
        Y.applyUpdate(fresh, canonical, network)
        await Promise.resolve()
        await Promise.resolve()
        expect(imageData(fresh).meta?.uploadLeaseAt).toBe(String(now))
        expect(imageData(fresh).name).toBe('renamed-by-old')
        // 真正的旧观察者在收到确认前已排队；确认后它再写回不认识的新字段。
        Y.applyUpdate(old, newPacket, network)
        Y.applyUpdate(old, canonical, network)
        await Promise.resolve()
        await Promise.resolve()
        if (newId! > oldId!) expect(imageData(old).meta?.uploadLeaseAt).toBeUndefined()
        else expect(imageData(old).meta?.uploadLeaseAt).toBe(String(now))
        // 新客户端先接到旧页补写，也必须在服务端下一轮规范化前保住原租约。
        Y.applyUpdate(fresh, Y.encodeStateAsUpdate(old), network)
        await Promise.resolve()
        await Promise.resolve()
        expect(imageData(fresh).meta?.uploadLeaseAt).toBe(String(now))
        expect(imageData(fresh).name).toBe('renamed-by-old')
        await send(old)
        const reopened = await canvasOf(id),
          lease = state(imageData(reopened))
        expect(lease.at).toBe(String(now))
        expect(imageData(reopened).name).toBe('renamed-by-old')
        expect(
          canvasUploadingElsewhere(
            imageData(reopened),
            'observer',
            now,
            canvasUploadNodeKey(reopened, 'photo'),
          ),
        ).toBe(true)
        expect(
          canvasUploadingElsewhere(
            imageData(reopened),
            'observer',
            now + LEASE_TTL,
            canvasUploadNodeKey(reopened, 'photo'),
          ),
        ).toBe(false)
        for (let i = 0; i < 2; i++) await send(old)
        const unchanged = await canvasOf(id)
        expect(state(imageData(unchanged))).toEqual(lease)
        unchanged.destroy()
        // 触发真实快照压缩并重载，不能按收到旧更新的时间给同一声明续命。
        await db
          .update(schema.canvas_documents)
          .set({ compacted_at: 0 })
          .where(eq(schema.canvas_documents.project_id, id))
        const vector = Y.encodeStateVector(reopened)
        moveCanvasNodes(reopened, [{ id: 'photo', x: 30, y: 40 }], origin)
        await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(reopened, vector))
        reopened.destroy()
        const compacted = await canvasOf(id)
        expect(state(imageData(compacted))).toEqual(lease)
        const [row] = await db
          .select()
          .from(schema.canvas_documents)
          .where(eq(schema.canvas_documents.project_id, id))
        expect(row!.compacted_sequence).toBeGreaterThan(0)
        const released = {
          ...imageData(compacted),
          meta: releaseCanvasUploadClaim(imageData(compacted).meta, now),
        }
        applyData(compacted, released)
        await send(compacted)
        Y.applyUpdate(old, await accessCanvasDocument('owner', id), network)
        // 旧页迟到的表单仍照抄撤销前的 claim；保留新编辑，不能恢复旧 claim。
        const stale = await canvasOf(id)
        applyData(old, { ...imageData(fresh), name: 'late-old-edit' })
        await send(old)
        Y.applyUpdate(stale, await accessCanvasDocument('owner', id), network)
        expect(imageData(stale).meta?.uploadDevice).toBeUndefined()
        expect(imageData(stale).name).toBe('late-old-edit')
        const releaseSnapshot = imageData(stale)
        applyData(stale, {
          ...releaseSnapshot,
          meta: claimCanvasUpload(
            releaseSnapshot,
            'reclaimed-device',
            now + 1,
            canvasUploadNodeKey(stale, 'photo'),
          ),
        })
        await send(stale)
        Y.applyUpdate(old, await accessCanvasDocument('owner', id), network)
        applyData(old, { ...releaseSnapshot, name: 'late-release-edit' })
        await send(old)
        const reclaimed = await canvasOf(id)
        expect(imageData(reclaimed).meta?.uploadDevice).toBe('reclaimed-device')
        expect(imageData(reclaimed).name).toBe('late-release-edit')
        const media = crypto.randomUUID()
        await readyMedia(media)
        promoteCanvasResultMedia(reclaimed, 'photo', 'original', media, origin)
        await send(reclaimed)
        Y.applyUpdate(old, await accessCanvasDocument('owner', id), network)
        await Promise.resolve()
        await send(old)
        const completed = await canvasOf(id)
        expect(imageData(completed)).toMatchObject({ mediaId: media, name: 'late-release-edit' })
        expect(imageData(completed).meta).not.toHaveProperty('uploadLeaseAt')
        const copied = await fetch(`${base}/api/projects/${id}/copy`, {
          method: 'POST',
          headers: { cookie },
        })
        expect(copied.status).toBe(200)
        const copyDoc = await canvasOf((await copied.json()).id)
        expect(imageData(copyDoc).mediaId).toBe(media)
        for (const doc of [compacted, stale, reclaimed, completed, copyDoc]) doc.destroy()
      } finally {
        stopOld()
        stopNew()
        fresh.destroy()
        old.destroy()
      }
    }, 15000)
it('expired leases survive replay, reload and compaction without new canonical state granting time', async () => {
  const { accessCanvasDocument } = await import('../../lib/canvasSyncStore')
  const id = await sourceFixture()
  const doc = await canvasOf(id)
  try {
    // An old claim alone does not cause the server to issue a lease on receive/reconnect.
    for (let i = 0; i < 2; i++) await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc))
    const unknown = await canvasOf(id)
    expect(imageData(unknown).meta?.uploadLeaseAt).toBeUndefined()
    unknown.destroy()
    const expiredAt = Date.now() - LEASE_TTL - 1000
    applyData(doc, {
      ...imageData(doc),
      meta: claimCanvasUpload(
        imageData(doc),
        'expired-device',
        expiredAt,
        canvasUploadNodeKey(doc, 'photo'),
      ),
    })
    await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc))
    const expired = await canvasOf(id)
    const canonical = state(imageData(expired))
    expect(canonical.at).toBe(String(expiredAt))
    expect(
      canvasUploadingElsewhere(
        imageData(expired),
        'observer',
        Date.now(),
        canvasUploadNodeKey(expired, 'photo'),
      ),
    ).toBe(false)
    // Even a causal same-claim write carrying a newer clock does not renew that claim.
    applyData(doc, {
      ...imageData(doc),
      name: 'still-expired',
      meta: { ...imageData(doc).meta, uploadLeaseAt: String(Date.now()) },
    })
    for (let i = 0; i < 2; i++) await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc))
    const replayed = await canvasOf(id)
    expect(state(imageData(replayed))).toEqual(canonical)
    expect(imageData(replayed).name).toBe('still-expired')
    await db
      .update(schema.canvas_documents)
      .set({ compacted_at: 0 })
      .where(eq(schema.canvas_documents.project_id, id))
    moveCanvasNodes(replayed, [{ id: 'photo', x: 88, y: 99 }], origin)
    await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(replayed))
    const reloaded = await canvasOf(id)
    expect(state(imageData(reloaded))).toEqual(canonical)
    expect(
      canvasUploadingElsewhere(
        imageData(reloaded),
        'observer',
        Date.now(),
        canvasUploadNodeKey(reloaded, 'photo'),
      ),
    ).toBe(false)
    expect(
      (await fetch(`${base}/api/projects/${id}/copy`, { method: 'POST', headers: { cookie } }))
        .status,
    ).toBe(409)
    for (const value of [expired, replayed, reloaded]) value.destroy()
  } finally {
    doc.destroy()
  }
})
it('database round trips do not lend a lease to replaced content, devices, stamps or node instances', async () => {
  const { accessCanvasDocument } = await import('../../lib/canvasSyncStore')
  const id = await sourceFixture(),
    doc = await canvasOf(id)
  try {
    const meta = claimCanvasUpload(
      imageData(doc),
      'original-device',
      Date.now(),
      canvasUploadNodeKey(doc, 'photo'),
    )
    const original = { ...imageData(doc), meta }
    applyData(doc, original)
    await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc))
    for (const changed of [
      { ...original, fileId: 'replacement' },
      { ...original, meta: { ...meta, contentIdentity: 'replacement-content' } },
      { ...original, meta: { ...meta, uploadDevice: 'different-device' } },
      { ...original, meta: { ...meta, uploadStartedAt: String(Number(meta.uploadStartedAt) + 1) } },
    ]) {
      applyData(doc, changed)
      await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc))
      const loaded = await canvasOf(id)
      expect(
        canvasUploadLeaseTime(imageData(loaded), canvasUploadNodeKey(loaded, 'photo')),
      ).toBeUndefined()
      expect(
        canvasUploadingElsewhere(
          imageData(loaded),
          'observer',
          Date.now(),
          canvasUploadNodeKey(loaded, 'photo'),
        ),
      ).toBe(false)
      loaded.destroy()
    }
    const previousKey = canvasUploadNodeKey(doc, 'photo')
    doc.getMap('nodes').delete('photo')
    insertCanvasNode(
      doc,
      { id: 'photo', type: 'image', x: 0, y: 0, width: 50, height: 50, data: original },
      origin,
    )
    expect(canvasUploadNodeKey(doc, 'photo')).not.toBe(previousKey)
    await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc))
    const rebuilt = await canvasOf(id)
    expect(
      canvasUploadLeaseTime(imageData(rebuilt), canvasUploadNodeKey(rebuilt, 'photo')),
    ).toBeUndefined()
    expect(
      (await fetch(`${base}/api/projects/${id}/copy`, { method: 'POST', headers: { cookie } }))
        .status,
    ).toBe(409)
    rebuilt.destroy()
  } finally {
    doc.destroy()
  }
})
