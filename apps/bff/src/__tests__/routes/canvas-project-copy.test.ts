import { afterAll, beforeAll, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  canvasOrigin,
  canvasResults,
  canvasSyncStep1,
  canvasSyncStep2,
  canvasSyncUpdate,
  moveCanvasNodes,
  readCanvasDocument,
  readCanvasSyncMessage,
  recordCanvasResult,
} from '@image-playground/shared'
import { count, eq } from 'drizzle-orm'
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
    sourceProjectId: string
    elementCount: number
    coverMediaId: string | null
  }
  expect(summary.id).not.toBe(sourceId)
  expect(summary.name).toBe('窗台 副本')
  expect(summary.conversationId).toBeNull()
  expect(summary.experience).toBe('canvas')
  expect(summary.sourceProjectId).toBe(sourceId)
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
  expect(project.document.sourceProjectId).toBe(sourceId)
  const sourceListed = await fetch(`${base}/api/projects/${sourceId}?identity=1`, {
    headers: { cookie },
  })
  expect(((await sourceListed.json()) as { conversationId: string }).conversationId).toBe(
    conversationId,
  )

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
    .where(eq(schema.canvas_projects.user_id, 'owner'))
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
