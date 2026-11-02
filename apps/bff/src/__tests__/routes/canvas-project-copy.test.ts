import { afterAll, beforeAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  CANVAS_UPLOAD_DEVICE_META,
  CANVAS_UPLOAD_STALE_MS,
  CANVAS_UPLOAD_STARTED_META,
  canvasOrigin,
  canvasResults,
  canvasSyncStep1,
  canvasSyncStep2,
  canvasSyncUpdate,
  insertCanvasNode,
  moveCanvasNodes,
  readCanvasDocument,
  readCanvasSyncMessage,
  recordCanvasResult,
} from '@image-playground/shared'
import { and, count, eq, isNull } from 'drizzle-orm'
import * as Y from 'yjs'

process.env.DATABASE_URL = await resetTestDatabase('canvas_project_copy')
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../canvas-sync-operator-config.json')
process.env.PORT = '0'
const { app } = await import('../../app')
const { startHttpServer } = await import('../../lib/httpServer')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
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
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.close(1000)
  }
  await waitUntil(() =>
    sockets.every(
      (ws) => ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING,
    ),
  )
  await waitUntil(() => app.server!.pendingWebSockets === 0)
  await canvasSyncRooms.close()
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

function connect(id: string, doc: Y.Doc) {
  const ws = new NativeSocket(`${base.replace('http', 'ws')}/api/projects/${id}/canvas/ws`, {
    headers: { cookie, origin: base },
  })
  sockets.push(ws)
  ws.binaryType = 'arraybuffer'
  let resolveAck: (() => void) | undefined
  ws.onmessage = (event) => {
    const message = readCanvasSyncMessage(new Uint8Array(event.data as ArrayBuffer))
    if (message.kind === 'vector') ws.send(canvasSyncStep2(doc, message.value))
    if (message.kind === 'update') Y.applyUpdate(doc, message.value, 'remote')
    if (message.kind === 'ack') resolveAck?.()
  }
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('socket failed'))
  })
  return {
    ws,
    opened,
    push: async (since: Uint8Array) => {
      const acked = new Promise<void>((resolve) => {
        resolveAck = resolve
      })
      ws.send(canvasSyncUpdate(Y.encodeStateAsUpdate(doc, since)))
      await acked
    },
  }
}

it('copies the committed canvas into a new project and leaves the source alone', async () => {
  const shot = crypto.randomUUID()
  const adopted = crypto.randomUUID()
  await readyMedia(shot)
  await readyMedia(adopted)
  const sourceId = crypto.randomUUID()
  const conversationId = crypto.randomUUID()
  const now = Date.now()
  const created = await fetch(`${base}/api/projects/${sourceId}`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      baseRevision: 0,
      name: '窗台',
      document: {
        version: 1,
        experience: 'canvas',
        sourceProjectId: 'chat-origin',
        elements: [
          {
            id: 'shot',
            type: 'image',
            mediaId: shot,
            x: 40,
            y: 20,
            width: 300,
            height: 200,
            rotation: 0,
          },
        ],
      },
    }),
  })
  expect(created.status).toBe(200)
  await db.insert(schema.agent_conversations).values({
    id: conversationId,
    user_id: 'owner',
    title: '源会话',
    created_at: now,
    updated_at: now,
  })
  await db
    .update(schema.canvas_projects)
    .set({ conversation_id: conversationId })
    .where(eq(schema.canvas_projects.id, sourceId))

  const anonymous = await fetch(`${base}/api/projects/${sourceId}/copy`, { method: 'POST' })
  expect(anonymous.status).toBe(401)

  const editing = new Y.Doc()
  Y.applyUpdate(editing, Y.encodeStateAsUpdate(await canvasOf(sourceId)))
  const socket = connect(sourceId, editing)
  await socket.opened
  await waitUntil(() => readCanvasDocument(editing).nodes.some((node) => node.id === 'shot'))
  const seeded = Y.encodeStateVector(editing)
  expect(
    recordCanvasResult(
      editing,
      {
        id: 'adopted-shot',
        nodeId: 'shot',
        kind: 'image',
        createdAt: now,
        adopted: true,
        source: { type: 'media', mediaId: adopted },
        display: { mediaId: adopted, fileId: `cloud-${adopted}` },
      },
      origin,
    ),
  ).toBe(true)
  await socket.push(seeded)
  editing.destroy()

  await db.insert(schema.canvas_commands).values({
    id: crypto.randomUUID(),
    project_id: sourceId,
    turn_id: 'turn',
    tool_call_id: 'call',
    fingerprint: 'fingerprint',
    label: '放置图片',
    before: 'e30=',
    update: 'e30=',
    created_at: now,
    updated_at: now,
  })
  const sourceBefore = await canvasOf(sourceId)

  const copied = await fetch(`${base}/api/projects/${sourceId}/copy`, {
    method: 'POST',
    headers: { cookie },
  })
  expect(copied.status).toBe(200)
  const summary = (await copied.json()) as {
    id: string
    name: string
    conversationId: string | null
    experience: string
    sourceProjectId?: string
    elementCount: number
    coverMediaId: string | null
  }
  expect(summary.id).not.toBe(sourceId)
  expect(summary.name).toBe('窗台 副本')
  expect(summary.conversationId).toBeNull()
  expect(summary.experience).toBe('canvas')
  expect(summary.sourceProjectId).toBeUndefined()
  expect(summary.elementCount).toBe(1)
  expect(summary.coverMediaId).toBe(shot)

  const copyDoc = await canvasOf(summary.id)
  const sourceAfter = await canvasOf(sourceId)
  expect(readCanvasDocument(copyDoc).nodes.find((node) => node.id === 'shot')).toMatchObject({
    x: 40,
    y: 20,
  })
  expect(canvasResults(copyDoc).map((result) => result.id)).toEqual(['adopted-shot'])
  expect(readCanvasDocument(sourceAfter)).toEqual(readCanvasDocument(sourceBefore))
  expect(canvasResults(sourceAfter).map((result) => result.id)).toEqual(['adopted-shot'])

  const listed = await fetch(`${base}/api/projects/${summary.id}?identity=1`, {
    headers: { cookie },
  })
  expect(listed.status).toBe(200)
  const project = (await listed.json()) as {
    conversationId: string | null
    document: { sourceProjectId?: string }
  }
  expect(project.conversationId).toBeNull()
  expect(project.document.sourceProjectId).toBeUndefined()
  const sourceListed = await fetch(`${base}/api/projects/${sourceId}?identity=1`, {
    headers: { cookie },
  })
  const sourceProject = (await sourceListed.json()) as {
    conversationId: string
    document: { sourceProjectId?: string }
  }
  expect(sourceProject.conversationId).toBe(conversationId)
  expect(sourceProject.document.sourceProjectId).toBe('chat-origin')

  const refs = async (ownerId: string) =>
    (
      await db
        .select({ mediaId: schema.media_references.media_id })
        .from(schema.media_references)
        .where(eq(schema.media_references.owner_id, ownerId))
    )
      .map((row) => row.mediaId)
      .sort()
  expect(await refs(summary.id)).toEqual([adopted, shot].sort())
  expect(await refs(sourceId)).toEqual([adopted, shot].sort())

  const updates = async (projectId: string) =>
    db
      .select({ sequence: schema.canvas_updates.sequence })
      .from(schema.canvas_updates)
      .where(eq(schema.canvas_updates.project_id, projectId))
  const commands = async (projectId: string) =>
    db
      .select({ id: schema.canvas_commands.id })
      .from(schema.canvas_commands)
      .where(eq(schema.canvas_commands.project_id, projectId))
  expect(await updates(summary.id)).toEqual([])
  expect((await updates(sourceId)).length).toBeGreaterThan(0)
  expect(await commands(summary.id)).toEqual([])
  expect((await commands(sourceId)).length).toBe(1)

  const copyEdit = new Y.Doc()
  Y.applyUpdate(copyEdit, Y.encodeStateAsUpdate(copyDoc))
  const copySocket = connect(summary.id, copyEdit)
  await copySocket.opened
  await waitUntil(() => readCanvasDocument(copyEdit).nodes.some((node) => node.id === 'shot'))
  const moving = Y.encodeStateVector(copyEdit)
  moveCanvasNodes(copyEdit, [{ id: 'shot', x: 480, y: 20 }], origin)
  await copySocket.push(moving)
  const sourceUntouched = await canvasOf(sourceId)
  expect(readCanvasDocument(sourceUntouched).nodes.find((node) => node.id === 'shot')?.x).toBe(40)
  expect(readCanvasDocument(copyEdit).nodes.find((node) => node.id === 'shot')?.x).toBe(480)
  const stranger = await fetch(`${base}/api/projects/${sourceId}/copy`, {
    method: 'POST',
    headers: { cookie: otherCookie },
  })
  expect(stranger.status).toBe(404)
  copyDoc.destroy()
  sourceBefore.destroy()
  sourceAfter.destroy()
  copyEdit.destroy()
  sourceUntouched.destroy()
})

async function putProject(name: string) {
  const id = crypto.randomUUID()
  const response = await fetch(`${base}/api/projects/${id}`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      baseRevision: 0,
      name,
      document: { version: 1, experience: 'canvas', elements: [] },
    }),
  })
  expect(response.status).toBe(200)
  return id
}

it('rejects a copy once the owner has reached the project quota', async () => {
  const sourceId = await putProject('配额')
  const { config } = await import('../../config')
  const [row] = await db
    .select({ count: count() })
    .from(schema.canvas_projects)
    .where(
      and(eq(schema.canvas_projects.user_id, 'owner'), isNull(schema.canvas_projects.deleted_at)),
    )
  const quotas = config.operator.quotas as { 'sync:user-projects': number }
  const previous = quotas['sync:user-projects']
  quotas['sync:user-projects'] = Number(row!.count)
  try {
    const response = await fetch(`${base}/api/projects/${sourceId}/copy`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(response.status).toBe(413)
    expect((await response.json()).error).toBe('project_quota_exceeded')
  } finally {
    quotas['sync:user-projects'] = previous
  }
})

it('rejects a copy of a deleted project', async () => {
  const sourceId = await putProject('已删')
  const removed = await fetch(`${base}/api/projects/${sourceId}`, {
    method: 'DELETE',
    headers: { cookie },
  })
  expect(removed.status).toBe(200)
  const response = await fetch(`${base}/api/projects/${sourceId}/copy`, {
    method: 'POST',
    headers: { cookie },
  })
  expect(response.status).toBe(410)
  expect((await response.json()).error).toBe('project_deleted')
})

it('shortens a copied name so it still fits the project name limit', async () => {
  const sourceId = await putProject('画'.repeat(120))
  const response = await fetch(`${base}/api/projects/${sourceId}/copy`, {
    method: 'POST',
    headers: { cookie },
  })
  expect(response.status).toBe(200)
  const summary = (await response.json()) as { name: string }
  expect(summary.name).toBe(`${'画'.repeat(117)} 副本`)
  expect([...summary.name].length).toBe(120)
})

it('uses a caller suffix and drops one that is not a short label', async () => {
  const sourceId = await putProject('窗台')
  const named = await fetch(`${base}/api/projects/${sourceId}/copy`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ suffix: 'copy' }),
  })
  expect(named.status).toBe(200)
  expect(((await named.json()) as { name: string }).name).toBe('窗台 copy')

  const rejected = await fetch(`${base}/api/projects/${sourceId}/copy`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ suffix: 'bad\nname' }),
  })
  expect(rejected.status).toBe(200)
  expect(((await rejected.json()) as { name: string }).name).toBe('窗台 副本')
})

it('本机媒体未解析时拒绝复制，包括已过期的声明', async () => {
  const { accessCanvasDocument } = await import('../../lib/canvasSyncStore')
  const sourceId = crypto.randomUUID()
  const created = await fetch(`${base}/api/projects/${sourceId}`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      baseRevision: 0,
      name: '上传中',
      document: { version: 1, experience: 'canvas', elements: [] },
    }),
  })
  expect(created.status).toBe(200)
  const write = async (startedAt: number) => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, await accessCanvasDocument('owner', sourceId))
    const vector = Y.encodeStateVector(doc)
    insertCanvasNode(
      doc,
      {
        id: `pending-${startedAt}`,
        type: 'image',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        data: {
          fileId: `local-${startedAt}`,
          meta: {
            [CANVAS_UPLOAD_DEVICE_META]: 'device-a',
            [CANVAS_UPLOAD_STARTED_META]: String(startedAt),
          },
        },
      },
      origin,
    )
    await accessCanvasDocument('owner', sourceId, Y.encodeStateAsUpdate(doc, vector))
  }
  const copy = () =>
    fetch(`${base}/api/projects/${sourceId}/copy`, { method: 'POST', headers: { cookie } })

  // 声明过期不代表副本能读到原图：仍拒绝，不能复制出永久缺图的副本。
  await write(Date.now() - CANVAS_UPLOAD_STALE_MS - 1000)
  expect((await copy()).status).toBe(409)

  await write(Date.now())
  const before = await db
    .select({ value: count() })
    .from(schema.canvas_projects)
    .where(eq(schema.canvas_projects.user_id, 'owner'))
  const pending = await copy()
  expect(pending.status).toBe(409)
  expect(await pending.json()).toEqual({ error: 'canvas_media_pending' })
  const after = await db
    .select({ value: count() })
    .from(schema.canvas_projects)
    .where(eq(schema.canvas_projects.user_id, 'owner'))
  expect(after[0]?.value).toBe(before[0]?.value)
})

async function pendingCopyFixture(meta: Record<string, string> | undefined) {
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
          name: 'Unresolved media',
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
      id: 'unresolved',
      type: 'image',
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      data: { fileId: 'local-original', ...(meta ? { meta } : {}) },
    },
    origin,
  )
  await accessCanvasDocument('owner', id, Y.encodeStateAsUpdate(doc, vector))
  doc.destroy()
  return id
}
for (const claim of [
  'future',
  'boundary',
  'expired',
  'released',
  'missing',
  'nan',
  'infinite',
  'negative',
])
  it(`copy rejects unresolved media independent of ${claim} upload bookkeeping, without writes`, async () => {
    const now = Date.now()
    const metas: Record<string, Record<string, string> | undefined> = {
      future: { uploadDevice: 'remote', uploadStartedAt: String(now + 6 * 60_000) },
      boundary: { uploadDevice: 'remote', uploadStartedAt: String(now + 5 * 60_000 + 1) },
      expired: { uploadDevice: 'remote', uploadStartedAt: String(now - 31 * 60_000) },
      released: { uploadReleasedAt: String(now) },
      missing: undefined,
      nan: { uploadDevice: 'remote', uploadStartedAt: 'NaN' },
      infinite: { uploadDevice: 'remote', uploadStartedAt: 'Infinity' },
      negative: { uploadDevice: 'remote', uploadStartedAt: '-1' },
    }
    const source = await pendingCopyFixture(metas[claim])
    const counts = async () => ({
      projects: await db.select({ n: count() }).from(schema.canvas_projects),
      documents: await db.select({ n: count() }).from(schema.canvas_documents),
      references: await db.select({ n: count() }).from(schema.media_references),
    })
    const before = await counts()
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(`${base}/api/projects/${source}/copy`, {
        method: 'POST',
        headers: { cookie },
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'canvas_media_pending' })
    }
    expect(await counts()).toEqual(before)
    const reopened = await canvasOf(source)
    expect(
      readCanvasDocument(reopened).nodes.find((n) => n.id === 'unresolved')?.data,
    ).toMatchObject({ fileId: 'local-original' })
    reopened.destroy()
  })
it('copy checks unselected local candidates and permits the same provenance after cloud promotion', async () => {
  const { accessCanvasDocument } = await import('../../lib/canvasSyncStore')
  const source = await pendingCopyFixture(undefined)
  const doc = await canvasOf(source)
  try {
    const media = crypto.randomUUID()
    await readyMedia(media)
    const vector = Y.encodeStateVector(doc)
    const image = doc.getMap<Y.Map<unknown>>('nodes').get('unresolved')!
    image.set('data', { fileId: `cloud-${media}`, mediaId: media })
    recordCanvasResult(
      doc,
      {
        id: 'unchosen-local',
        nodeId: 'unresolved',
        kind: 'image',
        source: { type: 'local', taskId: 'browser-only-task', outputIndex: 0 },
        createdAt: Date.now(),
      },
      origin,
    )
    await accessCanvasDocument('owner', source, Y.encodeStateAsUpdate(doc, vector))
    const blocked = await fetch(`${base}/api/projects/${source}/copy`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(blocked.status).toBe(409)
    const before = Y.encodeStateVector(doc)
    const result = canvasResults(doc).find((r) => r.id === 'unchosen-local')!
    doc
      .getMap('nodeResults')
      .set(result.id, { ...result, display: { mediaId: media, fileId: `cloud-${media}` } })
    await accessCanvasDocument('owner', source, Y.encodeStateAsUpdate(doc, before))
    const allowed = await fetch(`${base}/api/projects/${source}/copy`, {
      method: 'POST',
      headers: { cookie },
    })
    expect(allowed.status).toBe(200)
    const copy = await canvasOf((await allowed.json()).id)
    expect(canvasResults(copy).find((r) => r.id === 'unchosen-local')).toMatchObject({
      source: { type: 'local' },
      display: { mediaId: media },
    })
    copy.destroy()
  } finally {
    doc.destroy()
  }
})
it('copy requires video originals for nodes and local candidates, while retaining server queue candidates', async () => {
  const { accessCanvasDocument } = await import('../../lib/canvasSyncStore')
  const source = await pendingCopyFixture(undefined)
  const doc = await canvasOf(source)
  const poster = crypto.randomUUID(),
    clip = crypto.randomUUID(),
    task = crypto.randomUUID()
  await readyMedia(poster)
  await readyMedia(clip)
  await db
    .update(schema.media_objects)
    .set({ content_type: 'video/mp4' })
    .where(eq(schema.media_objects.id, clip))
  await db.insert(schema.tasks).values({
    id: task,
    user_id: 'owner',
    provider: 'openai-compat',
    model: 'fixture',
    status: 'completed',
    request_payload: { prompt: 'fixture' },
    submitted_at: Date.now(),
  })
  const copy = () =>
    fetch(`${base}/api/projects/${source}/copy`, { method: 'POST', headers: { cookie } })
  const flush = async (before: Uint8Array) =>
    accessCanvasDocument('owner', source, Y.encodeStateAsUpdate(doc, before))
  try {
    let before = Y.encodeStateVector(doc)
    doc
      .getMap<Y.Map<unknown>>('nodes')
      .get('unresolved')!
      .set('data', { fileId: `cloud-${poster}`, mediaId: poster })
    insertCanvasNode(
      doc,
      {
        id: 'video',
        type: 'video',
        x: 60,
        y: 0,
        width: 50,
        height: 50,
        data: {
          fileId: `cloud-${poster}`,
          mediaId: poster,
          video: { taskId: task, outputIndex: 0 },
        },
      },
      origin,
    )
    await flush(before)
    expect((await copy()).status).toBe(409)
    before = Y.encodeStateVector(doc)
    const node = readCanvasDocument(doc).nodes.find((n) => n.type === 'video')!
    doc
      .getMap<Y.Map<unknown>>('nodes')
      .get('video')!
      .set('data', { ...node.data, video: { taskId: task, outputIndex: 0, mediaId: clip } })
    recordCanvasResult(
      doc,
      {
        id: 'local-video',
        nodeId: 'video',
        kind: 'video',
        source: { type: 'local', taskId: task, outputIndex: 0 },
        display: { mediaId: poster, video: { taskId: task, outputIndex: 0 } },
        createdAt: Date.now(),
      },
      origin,
    )
    recordCanvasResult(
      doc,
      {
        id: 'queue-image',
        nodeId: 'unresolved',
        kind: 'image',
        source: { type: 'queue', taskId: task, outputIndex: 0 },
        createdAt: Date.now(),
      },
      origin,
    )
    await flush(before)
    expect((await copy()).status).toBe(409)
    before = Y.encodeStateVector(doc)
    const result = canvasResults(doc).find((r) => r.id === 'local-video')!
    doc.getMap('nodeResults').set(result.id, {
      ...result,
      display: { mediaId: poster, video: { taskId: task, outputIndex: 0, mediaId: clip } },
    })
    await flush(before)
    const allowed = await copy()
    expect(allowed.status).toBe(200)
    const copied = await canvasOf((await allowed.json()).id)
    expect(
      canvasResults(copied)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['local-video', 'queue-image'])
    expect(
      readCanvasDocument(copied).nodes.find((n) => n.type === 'video')?.data.video?.mediaId,
    ).toBe(clip)
    copied.destroy()
  } finally {
    doc.destroy()
  }
})
