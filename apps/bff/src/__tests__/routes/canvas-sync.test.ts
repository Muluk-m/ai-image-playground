import { afterAll, beforeAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  canvasNodeJobs,
  canvasOrigin,
  canvasResults,
  canvasSyncStep1,
  canvasSyncStep2,
  canvasSyncUpdate,
  canvasText,
  createCanvasGroup,
  createCanvasUndoManager,
  disconnectCanvasNodes,
  importLegacyElements,
  insertCanvasNode,
  moveCanvasGroups,
  moveCanvasNodes,
  readCanvasDocument,
  readCanvasGroups,
  readCanvasSyncMessage,
  recordCanvasResult,
  setCanvasNodeJob,
  updateCanvasNode,
} from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import * as Y from 'yjs'

process.env.DATABASE_URL = await resetTestDatabase('canvas_sync')
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../canvas-sync-operator-config.json')
process.env.PORT = '0'
const { app } = await import('../../app')
const { startHttpServer } = await import('../../lib/httpServer')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { accessCanvasDocument } = await import('../../lib/canvasSyncStore')
const { CanvasSyncRooms } = await import('../../lib/canvasSyncRooms')
// Bun supports authenticated WS headers; lib.dom's constructor omits the Bun overload.
const NativeSocket = WebSocket as unknown as {
  new (url: string, options: Bun.WebSocketOptions): WebSocket & { terminate(): void }
}
let cookie: string
let otherCookie: string
let base: string
const origin = canvasOrigin('user', 'test')
const sockets: Array<WebSocket & { terminate(): void }> = []
beforeAll(async () => {
  const now = Date.now()
  for (const id of ['owner', 'other'])
    await db.insert(schema.users).values({
      id,
      username: id,
      password_hash: 'unused',
      status: 'active',
      created_at: now,
      updated_at: now,
    })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('owner', tx))}`
  otherCookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('other', tx))}`
  startHttpServer(app, { port: 0, hostname: '127.0.0.1' })
  base = `http://127.0.0.1:${app.server!.port}`
})
afterAll(async () => {
  const { canvasSyncRooms } = await import('../../lib/canvasSyncRooms')
  await canvasSyncRooms.close()
  for (const ws of sockets) ws.terminate()
  await waitUntil(() => app.server!.pendingWebSockets === 0)
  await app.server!.stop(true)
  await close()
}, 15_000)
async function waitUntil(condition: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000
  while (!(await condition())) {
    if (Date.now() > end) throw new Error('condition timeout')
    await Bun.sleep(20)
  }
}
const legacy = {
  version: 1 as const,
  elements: [
    {
      id: 'title',
      type: 'text' as const,
      text: '旧存档',
      x: 10,
      y: 20,
      width: 300,
      height: 100,
      fontSize: 16,
      fill: '#fff',
    },
  ],
}
async function create() {
  const id = crypto.randomUUID()
  const response = await fetch(`${base}/api/projects/${id}`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      baseRevision: 0,
      name: '同步测试',
      document: legacy,
    }),
  })
  expect(response.status).toBe(200)
  return id
}
async function connect(id: string, doc: Y.Doc) {
  const ws = new NativeSocket(`${base.replace('http', 'ws')}/api/projects/${id}/canvas/ws`, {
    headers: { cookie, origin: base },
  })
  sockets.push(ws)
  ws.binaryType = 'arraybuffer'
  ws.onmessage = (event) => {
    const message = readCanvasSyncMessage(new Uint8Array(event.data))
    if (message.kind === 'vector') ws.send(canvasSyncStep2(doc, message.value))
    if (message.kind === 'update') Y.applyUpdate(doc, message.value, 'remote')
  }
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('socket failed'))
  })
  ws.send(canvasSyncStep1(doc))
  await waitUntil(() => readCanvasDocument(doc).nodes.some((n) => n.id === 'title'))
  return ws
}
it('migrates once, retains exact legacy archive, blocks stale JSON clients', async () => {
  const id = await create()
  const [a, b] = await Promise.all([
    accessCanvasDocument('owner', id),
    accessCanvasDocument('owner', id),
  ])
  expect(a).toEqual(b)
  const [row] = await db
    .select()
    .from(schema.canvas_documents)
    .where(eq(schema.canvas_documents.project_id, id))
  expect(row!.legacy_document).toEqual(legacy)
  const response = await fetch(`${base}/api/projects/${id}`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      baseRevision: 1,
      name: 'old',
      document: { version: 1, elements: [] },
    }),
  })
  expect(response.status).toBe(409)
  expect((await response.json()).error).toBe('project_canvas_upgrade_required')
})
it('two real sockets converge and a disconnected editor merges on reconnect', async () => {
  const id = await create()
  const a = new Y.Doc()
  const b = new Y.Doc()
  const wa = await connect(id, a)
  const wb = await connect(id, b)
  const va = Y.encodeStateVector(a)
  const vb = Y.encodeStateVector(b)
  moveCanvasNodes(a, [{ id: 'title', x: 90, y: 80 }], origin)
  insertCanvasNode(
    b,
    { id: 'image', type: 'image', x: 600, y: 20, width: 300, height: 200, data: {} },
    origin,
  )
  wa.send(canvasSyncUpdate(Y.encodeStateAsUpdate(a, va)))
  wb.send(canvasSyncUpdate(Y.encodeStateAsUpdate(b, vb)))
  await waitUntil(
    () => readCanvasDocument(a).nodes.length === 2 && readCanvasDocument(b).nodes[0]?.x === 90,
  )
  wb.close(1000)
  await waitUntil(() => wb.readyState === WebSocket.CLOSED)
  moveCanvasNodes(b, [{ id: 'image', x: 700, y: 100 }], origin)
  const vc = Y.encodeStateVector(a)
  moveCanvasNodes(a, [{ id: 'title', x: 150, y: 80 }], origin)
  wa.send(canvasSyncUpdate(Y.encodeStateAsUpdate(a, vc)))
  await connect(id, b)
  await waitUntil(
    () =>
      readCanvasDocument(a).nodes.find((n) => n.id === 'image')?.x === 700 &&
      readCanvasDocument(b).nodes.find((n) => n.id === 'title')?.x === 150,
  )
  expect(readCanvasDocument(a)).toEqual(readCanvasDocument(b))
})
it('compacts atomically and another process listener catches persisted changes', async () => {
  const id = await create()
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await accessCanvasDocument('owner', id))
  const room = new CanvasSyncRooms()
  const observed = new Y.Doc()
  const peer = {
    authorize: async () => true,
    send(bytes: Uint8Array) {
      const message = readCanvasSyncMessage(bytes)
      if (message.kind === 'update') Y.applyUpdate(observed, message.value)
    },
    close() {},
  }
  await room.join(id, 'owner', peer)
  try {
    await db
      .update(schema.canvas_documents)
      .set({ compacted_at: 0 })
      .where(eq(schema.canvas_documents.project_id, id))
    const vector = Y.encodeStateVector(doc)
    moveCanvasNodes(doc, [{ id: 'title', x: 222, y: 333 }], origin)
    await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc, vector))
    await waitUntil(() => readCanvasDocument(observed).nodes[0]?.x === 222)
    const restored = new Y.Doc()
    Y.applyUpdate(restored, await accessCanvasDocument('owner', id))
    expect(readCanvasDocument(restored)).toEqual(readCanvasDocument(doc))
    const log = await db
      .select()
      .from(schema.canvas_updates)
      .where(eq(schema.canvas_updates.project_id, id))
    expect(log).toHaveLength(0)
    const [backup] = await db
      .select()
      .from(schema.canvas_documents)
      .where(eq(schema.canvas_documents.project_id, id))
    expect(backup!.legacy_document).toEqual(legacy)
  } finally {
    room.leave(id, peer)
    await room.close()
  }
})
it('denies anonymous, non-owner, invalid origins, deleted projects and foreign media', async () => {
  const id = await create()
  expect((await fetch(`${base}/api/projects/${id}/canvas`)).status).toBe(401)
  expect(
    (await fetch(`${base}/api/projects/${id}/canvas`, { headers: { cookie: otherCookie } })).status,
  ).toBe(404)
  for (const [headers, expected] of [
    [{ cookie, origin: 'https://evil.example' }, 403],
    [{ cookie: otherCookie, origin: base }, 404],
    [{ origin: base }, 401],
  ] as const) {
    // Reject upgrades before handing the request to Bun.
    const response = await fetch(`${base}/api/projects/${id}/canvas/ws`, {
      headers: {
        ...headers,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    })
    expect(response.status).toBe(expected)
    await response.text()
  }
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await accessCanvasDocument('owner', id))
  const vector = Y.encodeStateVector(doc)
  const mediaId = crypto.randomUUID()
  insertCanvasNode(
    doc,
    {
      id: 'stolen',
      type: 'image',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      data: { mediaId, fileId: `cloud-${mediaId}` },
    },
    origin,
  )
  await expect(
    accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc, vector)),
  ).rejects.toThrow('canvas_media_not_owned')
  const clean = new Y.Doc()
  Y.applyUpdate(clean, await accessCanvasDocument('owner', id))
  expect(readCanvasDocument(clean).nodes).toHaveLength(1)
  await db
    .update(schema.canvas_projects)
    .set({ deleted_at: Date.now() })
    .where(eq(schema.canvas_projects.id, id))
  await expect(accessCanvasDocument('owner', id)).rejects.toThrow('project_deleted')
})

it('revokes an already connected session before accepting another update', async () => {
  const { revokeUserSession } = await import('../../lib/user-session')
  const id = await create()
  const doc = new Y.Doc()
  const ws = await connect(id, doc)
  const token = cookie.slice(cookie.indexOf('=') + 1)
  await revokeUserSession(token)
  ws.send(canvasSyncStep1(doc))
  await waitUntil(() => ws.readyState === WebSocket.CLOSED)
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('owner', tx))}`
  doc.destroy()
})

it('revokes an idle socket before broadcasting changes from another device', async () => {
  const { revokeUserSession } = await import('../../lib/user-session')
  const { canvasSyncRooms } = await import('../../lib/canvasSyncRooms')
  const id = await create()
  const doc = new Y.Doc()
  const ws = await connect(id, doc)
  const token = cookie.slice(cookie.indexOf('=') + 1)
  await revokeUserSession(token)
  await canvasSyncRooms.refresh(id)
  await waitUntil(() => ws.readyState === WebSocket.CLOSED)
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('owner', tx))}`
  doc.destroy()
})

it('closes a socket whose pending frames exceed the queue budget', async () => {
  const id = await create()
  const doc = new Y.Doc()
  const ws = await connect(id, doc)
  let closeCode = 0
  ws.addEventListener('close', (event) => {
    closeCode = event.code
  })
  let unlock!: () => void
  let locked!: () => void
  const held = new Promise<void>((resolve) => {
    locked = resolve
  })
  const release = new Promise<void>((resolve) => {
    unlock = resolve
  })
  const blocker = db.transaction(async (tx) => {
    await tx.select().from(schema.users).where(eq(schema.users.id, 'owner')).for('update')
    locked()
    await release
  })
  await held
  try {
    const frame = canvasSyncStep1(doc)
    for (let i = 0; i < 40; i++) ws.send(frame)
    await waitUntil(() => ws.readyState === WebSocket.CLOSED)
    expect(closeCode).toBe(1013)
  } finally {
    unlock()
    await blocker
    doc.destroy()
  }
})

it('keeps accepted video references writable after queue retention, rejecting new unknown tasks', async () => {
  const id = await create()
  const mediaId = crypto.randomUUID()
  const now = Date.now()
  await db.insert(schema.media_objects).values({
    id: mediaId,
    user_id: 'owner',
    sha256: mediaId,
    bytes: 1,
    content_type: 'image/png',
    status: 'ready',
    reserved_bytes: 0,
    staging_key: mediaId,
    object_key: mediaId,
    expires_at: now + 86400000,
    created_at: now,
    updated_at: now,
  })
  await db
    .update(schema.canvas_projects)
    .set({
      document: {
        version: 1,
        elements: [
          ...legacy.elements,
          {
            id: 'old-video',
            type: 'image',
            mediaId,
            x: 300,
            y: 0,
            width: 100,
            height: 100,
            rotation: 0,
            video: { taskId: 'expired-owned-task', outputIndex: 0 },
          },
        ],
      },
    })
    .where(eq(schema.canvas_projects.id, id))
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await accessCanvasDocument('owner', id))
  const vector = Y.encodeStateVector(doc)
  moveCanvasNodes(doc, [{ id: 'title', x: 111, y: 222 }], origin)
  await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc, vector))
  const video = readCanvasDocument(doc).nodes.find((node) => node.id === 'old-video')!
  const next = Y.encodeStateVector(doc)
  updateCanvasNode(
    doc,
    video.id,
    { data: { ...video.data, video: { taskId: 'unowned-new-task', outputIndex: 0 } } },
    origin,
  )
  await expect(accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc, next))).rejects.toThrow(
    'canvas_task_not_owned',
  )
  doc.destroy()
})

it('retains trusted old connection permissions across deletion, compaction and undo', async () => {
  const id = await create()
  const archived = new Y.Doc()
  importLegacyElements(archived, legacy.elements, origin)
  insertCanvasNode(
    archived,
    {
      id: 'old-video',
      type: 'image',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
      data: { meta: { nodeKind: 'video' } },
    },
    origin,
  )
  archived
    .getMap('edges')
    .set('old-video:title', { id: 'old-video:title', source: 'old-video', target: 'title' })
  await db.insert(schema.canvas_documents).values({
    project_id: id,
    snapshot: Buffer.from(Y.encodeStateAsUpdate(archived)).toString('base64'),
    legacy_document: legacy,
    migrated_at: Date.now(),
    compacted_at: Date.now(),
  })
  const client = new Y.Doc()
  Y.applyUpdate(client, await accessCanvasDocument('owner', id))
  const undo = createCanvasUndoManager(client, origin)
  disconnectCanvasNodes(client, 'old-video:title', origin)
  await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(client))
  await db
    .update(schema.canvas_documents)
    .set({ compacted_at: 0 })
    .where(eq(schema.canvas_documents.project_id, id))
  undo.undo()
  const restored = new Y.Doc()
  Y.applyUpdate(restored, await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(client)))
  expect(readCanvasDocument(restored).edges).toEqual([
    { id: 'old-video:title', source: 'old-video', target: 'title' },
  ])
  client.getMap('legacyConnections').set('forged:title', 'forged')
  await expect(
    accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(client)),
  ).rejects.toMatchObject({ status: 400 })
  undo.destroy()
  client.destroy()
  restored.destroy()
  archived.destroy()
})

it('persists group membership and movement with the same cloud document', async () => {
  const id = await create(),
    doc = new Y.Doc()
  Y.applyUpdate(doc, await accessCanvasDocument('owner', id))
  createCanvasGroup(doc, 'scene', ['title'], '第一场', origin)
  await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc))
  moveCanvasGroups(doc, [{ id: 'scene', x: 300, y: 200 }], origin)
  const restored = new Y.Doc()
  Y.applyUpdate(restored, await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc)))
  expect(readCanvasGroups(restored)).toEqual(readCanvasGroups(doc))
  expect(readCanvasDocument(restored).nodes[0]).toMatchObject({ x: 332, y: 264 })
  doc.destroy()
  restored.destroy()
})

it('persists concurrent rich text edits and keeps the legacy read model in sync', async () => {
  const id = await create()
  const a = new Y.Doc(),
    b = new Y.Doc()
  const snapshot = await accessCanvasDocument('owner', id)
  Y.applyUpdate(a, snapshot)
  Y.applyUpdate(b, snapshot)
  a.transact(() => canvasText(a, 'title')!.insert(0, '第一幕：'), origin)
  b.transact(() => {
    canvasText(b, 'title')!.insert(3, '继续创作')
    canvasText(b, 'title')!.format(3, 1, { header: 1 })
  }, origin)
  await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(a))
  await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(b))
  const restored = new Y.Doc()
  Y.applyUpdate(restored, await accessCanvasDocument('owner', id))
  expect(canvasText(restored, 'title')!.toString()).toContain('第一幕：')
  expect(canvasText(restored, 'title')!.toString()).toContain('继续创作')
  expect(
    canvasText(restored, 'title')!
      .toDelta()
      .some((op: { attributes?: { header?: number } }) => op.attributes?.header === 1),
  ).toBe(true)
  const [project] = await db
    .select()
    .from(schema.canvas_projects)
    .where(eq(schema.canvas_projects.id, id))
  expect(project!.document.elements[0]).toMatchObject({ text: '第一幕：旧存档继续创作' })
  a.destroy()
  b.destroy()
  restored.destroy()
})

it('authorizes candidate tasks without charging media storage and preserves references after expiry', async () => {
  const id = await create()
  const taskId = crypto.randomUUID(),
    otherTaskId = crypto.randomUUID()
  for (const [task, user] of [
    [taskId, 'owner'],
    [otherTaskId, 'other'],
  ])
    await db.insert(schema.tasks).values({
      id: task!,
      user_id: user!,
      provider: 'openai-compat',
      model: 'fixture',
      status: 'completed',
      request_payload: { prompt: 'fixture' },
      submitted_at: Date.now(),
    })
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await accessCanvasDocument('owner', id))
  const vector = Y.encodeStateVector(doc)
  insertCanvasNode(
    doc,
    { id: 'candidate-node', type: 'image', x: 300, y: 0, width: 300, height: 200, data: {} },
    origin,
  )
  recordCanvasResult(
    doc,
    {
      id: 'owned-result',
      nodeId: 'candidate-node',
      kind: 'image',
      source: { type: 'queue', taskId, outputIndex: 0 },
      createdAt: Date.now(),
    },
    origin,
  )
  await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc, vector))
  expect(
    await db.select().from(schema.media_references).where(eq(schema.media_references.owner_id, id)),
  ).toHaveLength(0)
  await db.delete(schema.tasks).where(eq(schema.tasks.id, taskId))
  const saved = new Y.Doc()
  Y.applyUpdate(saved, await accessCanvasDocument('owner', id))
  expect(canvasResults(saved)).toHaveLength(1)
  const before = Y.encodeStateVector(saved)
  moveCanvasNodes(saved, [{ id: 'candidate-node', x: 400, y: 10 }], origin)
  await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(saved, before))
  const hidden = new Y.Doc()
  Y.applyUpdate(hidden, Y.encodeStateAsUpdate(saved))
  const hiddenVector = Y.encodeStateVector(hidden)
  recordCanvasResult(
    hidden,
    {
      id: 'hidden-video',
      nodeId: 'candidate-node',
      kind: 'video',
      source: { type: 'local', taskId: 'local-history', outputIndex: 0 },
      createdAt: Date.now(),
      display: { video: { taskId: otherTaskId, outputIndex: 0 } },
    },
    origin,
  )
  await expect(
    accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(hidden, hiddenVector)),
  ).rejects.toThrow('canvas_task_not_owned')
  hidden.destroy()
  const unauthorized = Y.encodeStateVector(saved)
  recordCanvasResult(
    saved,
    {
      id: 'stolen-result',
      nodeId: 'candidate-node',
      kind: 'image',
      source: { type: 'queue', taskId: otherTaskId, outputIndex: 0 },
      createdAt: Date.now(),
    },
    origin,
  )
  await expect(
    accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(saved, unauthorized)),
  ).rejects.toThrow('canvas_task_not_owned')
  const reloaded = new Y.Doc()
  Y.applyUpdate(reloaded, await accessCanvasDocument('owner', id))
  expect(canvasResults(reloaded)).toHaveLength(1)
  doc.destroy()
  saved.destroy()
  reloaded.destroy()
})

it('checks every fan-out job task, not only the visible pending job', async () => {
  const id = await create()
  const owned = crypto.randomUUID(),
    other = crypto.randomUUID()
  for (const [task, user] of [
    [owned, 'owner'],
    [other, 'other'],
  ])
    await db.insert(schema.tasks).values({
      id: task!,
      user_id: user!,
      provider: 'openai-compat',
      model: 'fixture',
      status: 'completed',
      request_payload: { prompt: 'fixture' },
      submitted_at: Date.now(),
    })
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await accessCanvasDocument('owner', id))
  const start = Y.encodeStateVector(doc)
  insertCanvasNode(
    doc,
    { id: 'jobs-node', type: 'image', x: 0, y: 0, width: 300, height: 200, data: {} },
    origin,
  )
  setCanvasNodeJob(
    doc,
    {
      id: 'first',
      nodeId: 'jobs-node',
      createdAt: 1,
      status: 'loading',
      message: '',
      meta: { nodeGeneration: true, prompt: 'test', clientRequestId: 'first', bffRequestId: owned },
    },
    origin,
  )
  await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc, start))
  const before = Y.encodeStateVector(doc)
  setCanvasNodeJob(
    doc,
    {
      id: 'hidden',
      nodeId: 'jobs-node',
      createdAt: 2,
      status: 'loading',
      message: '',
      meta: {
        nodeGeneration: true,
        prompt: 'test',
        clientRequestId: 'hidden',
        bffRequestId: other,
      },
    },
    origin,
  )
  await expect(
    accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc, before)),
  ).rejects.toThrow('canvas_task_not_owned')
  const saved = new Y.Doc()
  Y.applyUpdate(saved, await accessCanvasDocument('owner', id))
  expect(canvasNodeJobs(saved).map((job) => job.id)).toEqual(['first'])
  doc.destroy()
  saved.destroy()
})
