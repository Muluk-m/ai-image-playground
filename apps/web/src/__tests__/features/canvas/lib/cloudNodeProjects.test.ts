// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import {
  canvasOrigin,
  canvasResults,
  canvasSyncAck,
  canvasSyncStep1,
  canvasSyncStep2,
  canvasSyncUpdate,
  chooseCanvasResult,
  deleteCanvasNode,
  importLegacyElements,
  insertCanvasNode,
  moveCanvasNodes,
  readCanvasDocument,
  readCanvasSyncMessage,
  recordCanvasResult,
} from '@image-playground/shared'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createArtifactDelivery } from '../../../../features/agent/lib/artifactDelivery'
import { artifactBitmap } from '../../../../features/agent/lib/artifactSource'
import { setAgentCanvasSink } from '../../../../features/agent/lib/canvasSink'
import type { AgentToolMessage } from '../../../../features/agent/types'
import { createAgentCanvasSink } from '../../../../features/canvas/lib/agentCanvasSink'
import { CloudNodeProjectSession } from '../../../../features/canvas/lib/cloudNodeProjects'
import { registerNodeCanvasFocus } from '../../../../features/canvas/lib/nodeCanvasFocus'
import type { CanvasCommandSummary } from '../../../../features/canvas/lib/nodeCanvasHistory'
import { type CloudSceneCheckpoint } from '../../../../features/canvas/lib/persistence'
import { getCloudProject, ProjectRequestError } from '../../../../features/canvas/lib/projectClient'
import { projectDocument } from '../../../../features/canvas/lib/projectMedia'
import {
  type CanvasProject,
  projectRepository,
} from '../../../../features/canvas/lib/projectRepository'
import type { SceneRecord } from '../../../../features/canvas/lib/sceneRecord'
import { authenticatedBffFetch } from '../../../../lib/authClient'
import { setClientStorageScope } from '../../../../lib/authScope'
import { uploadMediaSource } from '../../../../lib/mediaUpload'
import { openSceneRecord } from '../../../helpers/sceneRecord'

const origin = canvasOrigin('user', 'fixture')
vi.mock('../../../../features/canvas/lib/projectClient', () => ({
  getCloudProject: vi.fn(async (id: string) => ({
    id,
    revision: 1,
    name: 'Cloud',
    elementCount: 1,
    document: { version: 1, elements: [] },
  })),
  putCloudProject: vi.fn(),
  ProjectRequestError: class extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message)
    }
  },
}))
vi.mock('../../../../features/agent/lib/artifactSource', () => ({
  artifactBitmap: vi.fn(async () => 'data:image/png;base64,AQID'),
}))
vi.mock('../../../../lib/authClient', () => ({ authenticatedBffFetch: vi.fn() }))
vi.mock('../../../../lib/runtimeConfig', () => ({ bffBaseUrl: () => 'http://localhost' }))
vi.mock('../../../../lib/mediaUpload', () => ({
  uploadMediaSource: vi.fn(async () => ({ id: '11111111-1111-4111-8111-111111111111' })),
}))
vi.mock('../../../../store', () => ({ useStore: { getState: () => ({ showToast: vi.fn() }) } }))
class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 1
  binaryType = ''
  sent: Uint8Array[] = []
  onopen?: () => void
  onclose?: (e: { code: number }) => void
  onmessage?: (e: { data: ArrayBuffer }) => void
  constructor() {
    Socket.instances.push(this)
    queueMicrotask(() => this.onopen?.())
  }
  send(data: Uint8Array) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
    this.onclose?.({ code: 1000 })
  }
  receive(data: Uint8Array) {
    this.onmessage?.({ data: new Uint8Array(data).buffer })
  }
}
const sessions: CloudNodeProjectSession[] = []
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Socket.instances = []
})
async function fixture(
  beforeLoad?: (project: CanvasProject, record: SceneRecord, server: Y.Doc) => Promise<void>,
) {
  const project = await projectRepository.create('Cloud', undefined, true)
  const record = await openSceneRecord(project.sceneKey)
  const server = new Y.Doc()
  importLegacyElements(
    server,
    [
      {
        id: 'text',
        type: 'text',
        text: 'Old',
        x: 1,
        y: 2,
        width: 300,
        height: 200,
        fontSize: 16,
        fill: '#fff',
      },
    ],
    origin,
  )
  vi.mocked(authenticatedBffFetch).mockImplementation(async (url) =>
    String(url).endsWith('/canvas/commands')
      ? Response.json([])
      : new Response(new Uint8Array(Y.encodeStateAsUpdate(server)).buffer),
  )
  vi.stubGlobal('WebSocket', Socket)
  await beforeLoad?.(project, record, server)
  const session = new CloudNodeProjectSession(project, record, () => {})
  sessions.push(session)
  await session.load()
  const socket = Socket.instances[Socket.instances.length - 1]!
  socket.receive(canvasSyncStep1(server))
  await vi.waitFor(() =>
    expect(socket.sent.some((bytes) => readCanvasSyncMessage(bytes).kind === 'update')).toBe(true),
  )
  return { session, record, socket, server, project }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}
function commandReads() {
  return vi
    .mocked(authenticatedBffFetch)
    .mock.calls.filter(([url, init]) => url.endsWith('/canvas/commands') && !init?.method)
}
function acknowledgeWrites(socket: Socket, server: Y.Doc) {
  const send = socket.send.bind(socket)
  vi.spyOn(socket, 'send').mockImplementation((data) => {
    send(data)
    const message = readCanvasSyncMessage(data)
    if (message.kind !== 'update') return
    Y.applyUpdate(server, message.value)
    queueMicrotask(() => socket.receive(canvasSyncAck(server)))
  })
}
it('uses the server migration and does not start a second JSON cloud writer', async () => {
  const { session, record, socket, server } = await fixture()
  expect(readCanvasDocument(session.canvas!.doc).nodes[0]).toMatchObject({ id: 'text', x: 1, y: 2 })
  expect(record.editor.doc.elements[0]).toMatchObject({ id: 'text', text: 'Old' })
  expect(session.getSnapshot().status).toBe('syncing')
  socket.receive(canvasSyncAck(server))
  expect(session.getSnapshot().status).toBe('saved')
  record.dispose()
})
it.each([
  false,
  true,
])('does not fork a clean legacy video archive (kind checkpoint: %s)', async (explicitKind) => {
  const copy = vi.spyOn(projectRepository, 'createRecoveryCopy')
  const { session, record, project } = await fixture(async (project, record) => {
    record.editor.doc.addElements([
      {
        id: 'Legacy',
        type: 'text',
        text: 'Legacy',
        x: 10,
        y: 20,
        width: 300,
        height: 200,
        fontSize: 16,
        fill: '#fff',
      },
    ])
    const document = projectDocument(record.editor.doc, new Map(), 'video', project)!
    const checkpoint: CloudSceneCheckpoint = {
      version: 1,
      name: project.name,
      revision: 1,
      ...(explicitKind ? { legacyKind: 'video' as const } : {}),
      savedContent: JSON.stringify([project.name, document]),
      pending: null,
      conflict: false,
    }
    vi.spyOn(record, 'checkpoint', 'get').mockReturnValue(checkpoint)
    vi.mocked(getCloudProject).mockResolvedValueOnce({
      id: project.id,
      revision: 1,
      name: project.name,
      elementCount: 1,
      createdAt: 1,
      updatedAt: 1,
      document,
    })
  })
  expect(project.kind).toBe('image')
  expect(copy).not.toHaveBeenCalled()
  const recovered = await session.resolveConflict('copy')
  expect(recovered?.kind).toBe('video')
  record.dispose()
})
it('keeps the legacy video identity on an unsynced migration recovery copy', async () => {
  const copy = vi.spyOn(projectRepository, 'createRecoveryCopy')
  const { record } = await fixture(async (project, record) => {
    record.editor.doc.addElements([
      {
        id: 'Saved',
        type: 'text',
        text: 'Saved',
        x: 10,
        y: 20,
        width: 300,
        height: 200,
        fontSize: 16,
        fill: '#fff',
      },
    ])
    const document = projectDocument(record.editor.doc, new Map(), 'video', project)!
    vi.spyOn(record, 'checkpoint', 'get').mockReturnValue({
      version: 1,
      name: project.name,
      revision: 1,
      savedContent: JSON.stringify([project.name, document]),
      pending: null,
      conflict: false,
    })
    record.editor.doc.addElements([
      {
        id: 'Not synced yet',
        type: 'text',
        text: 'Not synced yet',
        x: 30,
        y: 40,
        width: 300,
        height: 200,
        fontSize: 16,
        fill: '#fff',
      },
    ])
    vi.mocked(getCloudProject).mockResolvedValueOnce({
      id: project.id,
      revision: 1,
      name: project.name,
      elementCount: 1,
      createdAt: 1,
      updatedAt: 1,
      document,
    })
  })
  expect(copy).toHaveBeenCalledTimes(1)
  expect(copy.mock.calls[0]?.[0].kind).toBe('video')
  expect((await copy.mock.results[0]?.value)?.kind).toBe('video')
  record.dispose()
})
it('does not call a newer local edit saved when an earlier update is acknowledged', async () => {
  const { session, record, socket, server } = await fixture()
  moveCanvasNodes(session.canvas!.doc, [{ id: 'text', x: 80, y: 90 }], session.canvas!.origin)
  socket.receive(canvasSyncAck(server))
  expect(session.getSnapshot().status).not.toBe('saved')
  await vi.waitFor(() =>
    expect(
      socket.sent.filter((bytes) => readCanvasSyncMessage(bytes).kind === 'update').length,
    ).toBeGreaterThan(1),
  )
  const last = readCanvasSyncMessage(socket.sent[socket.sent.length - 1]!)
  Y.applyUpdate(server, last.value)
  socket.receive(canvasSyncAck(server))
  expect(session.getSnapshot().status).toBe('saved')
  record.dispose()
})
it('merges remote edits without echoing legacy projections and normalizes uploaded media', async () => {
  const { session, record, socket, server } = await fixture()
  socket.receive(canvasSyncAck(server))
  const vector = Y.encodeStateVector(server)
  moveCanvasNodes(server, [{ id: 'text', x: 444, y: 555 }], origin)
  socket.receive(canvasSyncUpdate(Y.encodeStateAsUpdate(server, vector)))
  expect(record.editor.doc.elements[0]).toMatchObject({ x: 444, y: 555 })
  record.editor.doc.files = { image: 'data:image/png;base64,aGVsbG8=' }
  insertCanvasNode(
    session.canvas!.doc,
    { id: 'image', type: 'image', x: 0, y: 0, width: 50, height: 50, data: { fileId: 'image' } },
    session.canvas!.origin,
  )
  await vi.waitFor(() =>
    expect(
      readCanvasDocument(session.canvas!.doc).nodes.find((n) => n.id === 'image')?.data,
    ).toMatchObject({
      mediaId: '11111111-1111-4111-8111-111111111111',
      fileId: 'cloud-11111111-1111-4111-8111-111111111111',
    }),
  )
  expect(record.editor.doc.files['cloud-11111111-1111-4111-8111-111111111111']).toBe(
    'aip-media:11111111-1111-4111-8111-111111111111',
  )
  record.dispose()
})

it('retries a failed media upload through sync without another edit or reconnect', async () => {
  const { session, record, socket, server } = await fixture()
  for (const bytes of socket.sent) {
    const message = readCanvasSyncMessage(bytes)
    if (message.kind === 'update') Y.applyUpdate(server, message.value)
  }
  socket.receive(canvasSyncAck(server))
  expect(session.getSnapshot().status).toBe('saved')
  const source = 'data:image/png;base64,aGVsbG8='
  const mediaId = '33333333-3333-4333-8333-333333333333'
  vi.mocked(uploadMediaSource)
    .mockClear()
    .mockRejectedValueOnce(new Error('upload unavailable'))
    .mockResolvedValueOnce({ id: mediaId, sha256: 'retry-fixture' })
  record.editor.doc.files = { image: source }
  insertCanvasNode(
    session.canvas!.doc,
    { id: 'image', type: 'image', x: 0, y: 0, width: 50, height: 50, data: { fileId: 'image' } },
    session.canvas!.origin,
  )
  await vi.waitFor(() => expect(session.getSnapshot().status).toBe('media-local'))
  expect(readCanvasDocument(server).nodes.map((node) => node.id)).toEqual(['text'])
  const sent = socket.sent.length
  const synced = session.sync()
  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(sent))
  for (const bytes of socket.sent.slice(sent)) {
    const message = readCanvasSyncMessage(bytes)
    if (message.kind === 'update') Y.applyUpdate(server, message.value)
  }
  const nodes = readCanvasDocument(server).nodes
  expect(nodes.map((node) => node.id).sort()).toEqual(['image', 'text'])
  expect(nodes.find((node) => node.id === 'image')?.data).toMatchObject({
    mediaId,
    fileId: `cloud-${mediaId}`,
  })
  expect(session.getSnapshot().status).toBe('syncing')
  socket.receive(canvasSyncAck(server))
  await synced
  expect(session.getSnapshot().status).toBe('saved')
  expect(Socket.instances).toHaveLength(1)
  expect(vi.mocked(uploadMediaSource).mock.calls.map(([value]) => value)).toEqual([source, source])
  record.dispose()
})

it('refresh waits for the fetched document to reach the legacy editor', async () => {
  const { session, record, server } = await fixture()
  moveCanvasNodes(server, [{ id: 'text', x: 909, y: 808 }], origin)
  await session.refresh()
  expect(record.editor.doc.elements[0]).toMatchObject({ x: 909, y: 808 })
  record.dispose()
})

it('keeps hidden heartbeats running without reading history for unchanged binary Step2 replies', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const { session, record, socket, server } = await fixture()
  socket.receive(canvasSyncAck(server))
  await session.refresh()
  const before = readCanvasDocument(session.canvas!.doc)
  const reads = commandReads().length
  const replies: Uint8Array[] = []
  const send = socket.send.bind(socket)
  vi.spyOn(socket, 'send').mockImplementation((data) => {
    send(data)
    const message = readCanvasSyncMessage(data)
    if (message.kind !== 'vector') return
    const reply = canvasSyncStep2(server, message.value)
    replies.push(reply)
    queueMicrotask(() => socket.receive(reply))
  })
  visibility.mockReturnValue('hidden')
  document.dispatchEvent(new Event('visibilitychange'))

  await vi.advanceTimersByTimeAsync(60_000)

  expect(replies).toHaveLength(3)
  for (const reply of replies) {
    expect(readCanvasSyncMessage(reply).kind).toBe('update')
    expect(reply).toEqual(canvasSyncStep2(server, Y.encodeStateVector(server)))
  }
  expect(commandReads()).toHaveLength(reads)
  expect(readCanvasDocument(session.canvas!.doc)).toEqual(before)
  expect(session.getSnapshot().status).toBe('saved')
  record.dispose()
})

it('merges hidden remote updates and completes media writes after vector and ACK messages', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const { session, record, socket, server } = await fixture()
  socket.receive(canvasSyncAck(server))
  await session.refresh()
  const reads = commandReads().length
  const upload = deferred<NonNullable<Awaited<ReturnType<typeof uploadMediaSource>>>>()
  vi.mocked(uploadMediaSource).mockImplementationOnce(() => upload.promise)
  visibility.mockReturnValue('hidden')
  const vector = Y.encodeStateVector(server)
  moveCanvasNodes(server, [{ id: 'text', x: 444, y: 555 }], origin)
  socket.receive(canvasSyncUpdate(Y.encodeStateAsUpdate(server, vector)))
  expect(readCanvasDocument(session.canvas!.doc).nodes[0]).toMatchObject({ x: 444, y: 555 })
  expect(record.editor.doc.elements[0]).toMatchObject({ x: 444, y: 555 })

  const sent = socket.sent.length
  record.editor.doc.files = { hidden: 'data:image/png;base64,aGlkZGVu' }
  insertCanvasNode(
    session.canvas!.doc,
    { id: 'hidden', type: 'image', x: 0, y: 0, width: 50, height: 50, data: { fileId: 'hidden' } },
    session.canvas!.origin,
  )
  socket.receive(canvasSyncStep1(server))
  await vi.waitFor(() =>
    expect(uploadMediaSource).toHaveBeenCalledWith(
      'data:image/png;base64,aGlkZGVu',
      expect.anything(),
    ),
  )
  expect(socket.sent).toHaveLength(sent)
  upload.resolve({ id: '11111111-1111-4111-8111-111111111111', sha256: 'hidden-image' })
  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(sent))
  const update = readCanvasSyncMessage(socket.sent[socket.sent.length - 1]!)
  expect(update.kind).toBe('update')
  Y.applyUpdate(server, update.value)
  expect(readCanvasDocument(server).nodes.find((node) => node.id === 'hidden')?.data).toMatchObject(
    {
      mediaId: '11111111-1111-4111-8111-111111111111',
    },
  )
  expect(session.getSnapshot().status).toBe('syncing')
  socket.receive(canvasSyncAck(server))
  expect(session.getSnapshot().status).toBe('saved')
  expect(commandReads()).toHaveLength(reads)
  record.dispose()
})

it('does not start history reads after a visible snapshot completes while hidden', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const { session, record, server } = await fixture()
  await session.refresh()
  const reads = commandReads().length
  const snapshot = deferred<Response>()
  vi.mocked(authenticatedBffFetch).mockImplementationOnce(() => snapshot.promise)
  const refresh = session.refresh()
  await vi.waitFor(() =>
    expect(authenticatedBffFetch).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/canvas$/),
      expect.anything(),
    ),
  )
  visibility.mockReturnValue('hidden')
  moveCanvasNodes(server, [{ id: 'text', x: 909, y: 808 }], origin)
  snapshot.resolve(new Response(new Uint8Array(Y.encodeStateAsUpdate(server)).buffer))
  await refresh
  expect(record.editor.doc.elements[0]).toMatchObject({ x: 909, y: 808 })
  expect(commandReads()).toHaveLength(reads)
  record.dispose()
})

it('allows an existing history read to finish after hiding without starting another', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const { session, record, socket, server } = await fixture()
  await session.refresh()
  const reads = commandReads().length
  const history = deferred<Response>()
  vi.mocked(authenticatedBffFetch).mockImplementationOnce(() => history.promise)
  socket.receive(canvasSyncStep2(server, Y.encodeStateVector(server)))
  expect(commandReads()).toHaveLength(reads + 1)
  visibility.mockReturnValue('hidden')
  socket.receive(canvasSyncStep2(server, Y.encodeStateVector(server)))
  history.resolve(
    Response.json([
      {
        id: 'hidden-command',
        label: 'Remote',
        revision: 1,
        reversed: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ]),
  )
  await vi.waitFor(() => expect(session.canvas!.undo.undoStack).toHaveLength(1))
  socket.receive(canvasSyncStep2(server, Y.encodeStateVector(server)))
  expect(commandReads()).toHaveLength(reads + 1)
  record.dispose()
})

it.each([
  { reverseStatus: 200, oldReadStatus: 200 },
  { reverseStatus: 200, oldReadStatus: 503 },
  { reverseStatus: 409, oldReadStatus: 200 },
  { reverseStatus: 409, oldReadStatus: 503 },
])('reads a fresh revision after hidden reverse $reverseStatus overlaps history $oldReadStatus', async ({
  reverseStatus,
  oldReadStatus,
}) => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const { session, record, socket, server } = await fixture()
  socket.receive(canvasSyncAck(server))
  await session.refresh()
  acknowledgeWrites(socket, server)
  let command: CanvasCommandSummary = {
    id: 'command',
    label: 'Remote edit',
    revision: 1,
    reversed: false,
    createdAt: 1,
    updatedAt: 1,
  }
  const oldRead = deferred<Response>()
  const reverse = deferred<Response>()
  const posted: unknown[] = []
  let reads = 0
  let inFlight = 0
  let maximumInFlight = 0
  let reverseReturned = false
  vi.mocked(authenticatedBffFetch).mockImplementation(async (url, init) => {
    if (url.endsWith('/reverse')) {
      posted.push(JSON.parse(String(init?.body)))
      if (posted.length === 1) {
        const response = await reverse.promise
        reverseReturned = true
        return response
      }
      command = { ...command, revision: 3, reversed: false, updatedAt: 3 }
      moveCanvasNodes(server, [{ id: 'text', x: 1, y: 2 }], origin)
      return new Response(new Uint8Array(Y.encodeStateAsUpdate(server)).buffer)
    }
    if (!url.endsWith('/canvas/commands'))
      return new Response(new Uint8Array(Y.encodeStateAsUpdate(server)).buffer)
    reads++
    inFlight++
    maximumInFlight = Math.max(maximumInFlight, inFlight)
    try {
      return reads === 2 ? await oldRead.promise : Response.json([command])
    } finally {
      inFlight--
    }
  })
  try {
    await session.refresh()
    const history = session.canvas!.undo
    expect(history.undoStack).toHaveLength(1)
    socket.receive(canvasSyncStep2(server, Y.encodeStateVector(server)))
    expect(reads).toBe(2)
    const stale = { ...command }
    history.undo()
    await vi.waitFor(() => expect(posted).toEqual([{ revision: 1 }]))
    visibility.mockReturnValue('hidden')
    command = { ...command, revision: 2, reversed: true, updatedAt: 2 }
    moveCanvasNodes(server, [{ id: 'text', x: 333, y: 444 }], origin)
    reverse.resolve(
      reverseStatus === 200
        ? new Response(new Uint8Array(Y.encodeStateAsUpdate(server)).buffer)
        : Response.json({ error: 'revision_conflict' }, { status: reverseStatus }),
    )
    await vi.waitFor(() => expect(reverseReturned).toBe(true))
    socket.receive(canvasSyncStep2(server, Y.encodeStateVector(server)))
    expect(reads).toBe(2)
    expect(inFlight).toBe(1)
    oldRead.resolve(Response.json([stale], { status: oldReadStatus }))
    await vi.waitFor(() => expect(history.redoStack).toHaveLength(1))
    expect(history.undoStack).toHaveLength(0)
    expect(reads).toBe(3)
    expect(posted).toEqual([{ revision: 1 }])

    history.redo()
    await vi.waitFor(() => expect(posted).toEqual([{ revision: 1 }, { revision: 2 }]))
    await vi.waitFor(() => expect(history.undoStack).toHaveLength(1))
    expect(history.redoStack).toHaveLength(0)
    expect(record.editor.doc.elements[0]).toMatchObject({ x: 1, y: 2 })
    expect(reads).toBe(4)
    expect(maximumInFlight).toBe(1)
  } finally {
    oldRead.resolve(Response.json([]))
    reverse.resolve(Response.json({}, { status: 503 }))
    record.dispose()
  }
})

it('reports a new history read failure after reverse instead of swallowing it as an old failure', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const { session, record, socket, server } = await fixture()
  socket.receive(canvasSyncAck(server))
  await session.refresh()
  acknowledgeWrites(socket, server)
  const command: CanvasCommandSummary = {
    id: 'command',
    label: 'Remote edit',
    revision: 1,
    reversed: false,
    createdAt: 1,
    updatedAt: 1,
  }
  let reversed = false
  let reads = 0
  vi.mocked(authenticatedBffFetch).mockImplementation(async (url) => {
    if (url.endsWith('/reverse')) reversed = true
    if (url.endsWith('/canvas/commands')) {
      reads++
      return reversed ? Response.json({}, { status: 503 }) : Response.json([command])
    }
    return new Response(new Uint8Array(Y.encodeStateAsUpdate(server)).buffer)
  })
  await session.refresh()
  visibility.mockReturnValue('hidden')
  session.canvas!.undo.undo()
  await vi.waitFor(() => expect(session.getSnapshot().status).toBe('offline'))
  expect(reads).toBe(2)
  expect(session.canvas!.undo.undoStack).toHaveLength(1)
  record.dispose()
})

it.each([
  'dispose',
  'account switch',
])('does not read history after %s while reverse waits for an old GET', async (endScope) => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const { session, record, socket, server } = await fixture()
  socket.receive(canvasSyncAck(server))
  await session.refresh()
  acknowledgeWrites(socket, server)
  const command: CanvasCommandSummary = {
    id: 'command',
    label: 'Remote edit',
    revision: 1,
    reversed: false,
    createdAt: 1,
    updatedAt: 1,
  }
  const oldRead = deferred<Response>()
  let reads = 0
  let reversals = 0
  vi.mocked(authenticatedBffFetch).mockImplementation(async (url) => {
    if (url.endsWith('/reverse')) reversals++
    if (url.endsWith('/canvas/commands')) {
      reads++
      return reads === 2 ? oldRead.promise : Response.json([command])
    }
    return new Response(new Uint8Array(Y.encodeStateAsUpdate(server)).buffer)
  })
  try {
    await session.refresh()
    const history = session.canvas!.undo
    socket.receive(canvasSyncStep2(server, Y.encodeStateVector(server)))
    expect(reads).toBe(2)
    history.undo()
    await vi.waitFor(() => expect(reversals).toBe(1))
    if (endScope === 'dispose') session.dispose()
    else setClientStorageScope('another-account')
    oldRead.resolve(Response.json([command]))
    await vi.waitFor(() => expect(history.undoStack).toHaveLength(1))
    expect(reads).toBe(2)
    expect(reversals).toBe(1)
  } finally {
    oldRead.resolve(Response.json([]))
    setClientStorageScope(null)
    record.dispose()
  }
})
it('preserves local failure placeholders through the legacy adapter', async () => {
  const { session, record } = await fixture()
  insertCanvasNode(
    session.canvas!.doc,
    {
      id: 'failed',
      type: 'image',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      data: {
        pending: {
          type: 'placeholder',
          status: 'error',
          message: 'Try again',
          meta: { nodeGeneration: true },
        },
      },
    },
    session.canvas!.origin,
  )
  expect(record.editor.doc.elements.find((el) => el.id === 'failed')).toMatchObject({
    type: 'placeholder',
    status: 'error',
    message: 'Try again',
    meta: { nodeGeneration: true },
  })
  record.dispose()
})
it('returns known Agent media without waiting for unrelated missing uploads', async () => {
  const { session, record } = await fixture()
  insertCanvasNode(
    session.canvas!.doc,
    {
      id: 'missing',
      type: 'image',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      data: { fileId: 'not-available' },
    },
    session.canvas!.origin,
  )
  const source = 'aip-media:11111111-1111-4111-8111-111111111111'
  expect(await session.mediaIdsFor([source])).toEqual(new Map([[source, source.slice(10)]]))
  record.dispose()
})
it('serializes overlapping renames so the latest name remains saved', async () => {
  const { session, record, project } = await fixture()
  const names: string[] = []
  let finish!: () => void
  vi.mocked(authenticatedBffFetch).mockImplementation(async (_url, init) => {
    names.push(JSON.parse(String(init?.body)).name)
    if (names.length === 1)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    return new Response('{}')
  })
  const first = session.rename('First')
  await vi.waitFor(() => expect(names).toEqual(['First']))
  const second = session.rename('Second')
  await vi.waitFor(async () =>
    expect((await projectRepository.list()).find((p) => p.id === project.id)?.name).toBe('Second'),
  )
  expect(names).toEqual(['First'])
  finish()
  await Promise.all([first, second])
  expect(names).toEqual(['First', 'Second'])
  record.dispose()
})

it.each([
  503, 403,
])('allows cached editing on a %i only when permission is still recoverable', async (status) => {
  const { session, record, project } = await fixture()
  session.dispose()
  vi.mocked(getCloudProject).mockRejectedValueOnce(new ProjectRequestError(status, 'unavailable'))
  const reopened = new CloudNodeProjectSession(project, record, () => {})
  sessions.push(reopened)
  if (status === 503) {
    await reopened.load()
    expect(readCanvasDocument(reopened.canvas!.doc).nodes[0]).toMatchObject({ id: 'text' })
  } else await expect(reopened.load()).rejects.toThrow('unavailable')
  record.dispose()
})

it('uploads only chosen candidates, including a previous main switched before the sync flush', async () => {
  const { session, record, socket, server } = await fixture()
  socket.receive(canvasSyncAck(server))
  vi.mocked(uploadMediaSource).mockClear()
  const { doc, origin } = session.canvas!
  record.editor.doc.files = { a: 'data:image/png;base64,YQ==', b: 'data:image/png;base64,Yg==' }
  insertCanvasNode(
    doc,
    { id: 'image', type: 'image', x: 0, y: 0, width: 50, height: 50, data: {} },
    origin,
  )
  for (const id of ['a', 'b', 'unchosen'])
    recordCanvasResult(
      doc,
      {
        id,
        nodeId: 'image',
        kind: 'image',
        source: { type: 'queue', taskId: id, outputIndex: 0 },
        createdAt: 1,
      },
      origin,
    )
  chooseCanvasResult(doc, 'image', 'a', { data: { fileId: 'a' } }, origin)
  chooseCanvasResult(doc, 'image', 'b', { data: { fileId: 'b' } }, origin)
  await vi.waitFor(() => {
    expect(canvasResults(doc).filter((r) => r.display?.mediaId)).toHaveLength(2)
  })
  expect(
    vi
      .mocked(uploadMediaSource)
      .mock.calls.map(([source]) => source)
      .sort(),
  ).toEqual(['data:image/png;base64,YQ==', 'data:image/png;base64,Yg=='])
  expect(canvasResults(doc).find((r) => r.id === 'unchosen')?.display).toBeUndefined()
  expect(record.editor.doc.elements.find((e) => e.id === 'image')).toMatchObject({
    fileId: 'cloud-11111111-1111-4111-8111-111111111111',
  })
  record.dispose()
})

it('promotes adopted video originals but leaves unchosen candidates in temporary storage', async () => {
  const { session, record } = await fixture()
  const { doc, origin } = session.canvas!
  const promoted: string[] = []
  vi.mocked(authenticatedBffFetch).mockImplementation(async (url, init) => {
    expect(String(url)).toContain('/api/media/video-outputs')
    const { taskId } = JSON.parse(String(init?.body))
    promoted.push(taskId)
    return Response.json({ id: '22222222-2222-4222-8222-222222222222' })
  })
  insertCanvasNode(
    doc,
    { id: 'video', type: 'image', x: 0, y: 0, width: 50, height: 50, data: {} },
    origin,
  )
  for (const id of ['one', 'two', 'unused'])
    recordCanvasResult(
      doc,
      {
        id,
        nodeId: 'video',
        kind: 'video',
        createdAt: 1,
        source: { type: 'queue', taskId: id, outputIndex: 0 },
        display: { video: { taskId: id, outputIndex: 0 } },
      },
      origin,
    )
  for (const taskId of ['one', 'two'])
    chooseCanvasResult(
      doc,
      'video',
      taskId,
      { data: { video: { taskId, outputIndex: 0 } } },
      origin,
    )
  await vi.waitFor(() =>
    expect(canvasResults(doc).filter((r) => r.display?.video?.mediaId)).toHaveLength(2),
  )
  expect(promoted.sort()).toEqual(['one', 'two'])
  expect(readCanvasDocument(doc).nodes.find((n) => n.id === 'video')?.data).toMatchObject({
    video: { taskId: 'two', mediaId: '22222222-2222-4222-8222-222222222222' },
  })
  record.dispose()
})

it('saves edits around expired legacy videos, and clears the warning after removal', async () => {
  const { session, record, socket, server } = await fixture()
  socket.receive(canvasSyncAck(server))
  const { doc, origin } = session.canvas!
  vi.mocked(authenticatedBffFetch)
    .mockClear()
    .mockResolvedValue(Response.json({ error: 'video_output_not_found' }, { status: 404 }))
  insertCanvasNode(
    doc,
    {
      id: 'expired',
      type: 'video',
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      data: { video: { taskId: 'expired-task', outputIndex: 0 } },
    },
    origin,
  )
  await vi.waitFor(() =>
    expect(authenticatedBffFetch).toHaveBeenCalledWith(
      expect.stringContaining('/video-outputs'),
      expect.anything(),
    ),
  )
  await vi.waitFor(() => {
    const last = readCanvasSyncMessage(socket.sent[socket.sent.length - 1]!)
    expect(last.kind).toBe('update')
    Y.applyUpdate(server, last.value)
    expect(readCanvasDocument(server).nodes.some((n) => n.id === 'expired')).toBe(true)
  })
  socket.receive(canvasSyncAck(server))
  expect(session.getSnapshot().status).toBe('media-local')
  const promotions = vi
    .mocked(authenticatedBffFetch)
    .mock.calls.filter(([url]) => String(url).endsWith('/video-outputs'))
  expect(promotions).toHaveLength(1)
  const sent = socket.sent.length
  const synced = session.sync()
  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(sent))
  Y.applyUpdate(server, readCanvasSyncMessage(socket.sent[socket.sent.length - 1]!).value)
  socket.receive(canvasSyncAck(server))
  await synced
  expect(session.getSnapshot().status).toBe('media-local')
  expect(
    vi
      .mocked(authenticatedBffFetch)
      .mock.calls.filter(([url]) => String(url).endsWith('/video-outputs')),
  ).toHaveLength(1)
  deleteCanvasNode(doc, 'expired', origin)
  await vi.waitFor(() => {
    Y.applyUpdate(server, readCanvasSyncMessage(socket.sent[socket.sent.length - 1]!).value)
    expect(readCanvasDocument(server).nodes.some((n) => n.id === 'expired')).toBe(false)
  })
  socket.receive(canvasSyncAck(server))
  expect(session.getSnapshot().status).toBe('saved')
  record.dispose()
})

it('does not send a saved version until videos selected during another promotion are retained', async () => {
  const { session, record, socket, server } = await fixture()
  socket.receive(canvasSyncAck(server))
  const { doc, origin } = session.canvas!
  const finishing = new Map<string, () => void>()
  vi.mocked(authenticatedBffFetch).mockImplementation(async (_url, init) => {
    const { taskId } = JSON.parse(String(init?.body))
    await new Promise<void>((resolve) => finishing.set(taskId, resolve))
    return Response.json({ id: '22222222-2222-4222-8222-222222222222' })
  })
  const sent = socket.sent.length
  insertCanvasNode(
    doc,
    { id: 'video', type: 'image', x: 0, y: 0, width: 50, height: 50, data: {} },
    origin,
  )
  for (const id of ['a', 'b'])
    recordCanvasResult(
      doc,
      {
        id,
        nodeId: 'video',
        kind: 'video',
        source: { type: 'queue', taskId: id, outputIndex: 0 },
        createdAt: 1,
        display: { video: { taskId: id, outputIndex: 0 } },
      },
      origin,
    )
  chooseCanvasResult(
    doc,
    'video',
    'a',
    { data: { video: { taskId: 'a', outputIndex: 0 } } },
    origin,
  )
  await vi.waitFor(() => expect(finishing.has('a')).toBe(true))
  chooseCanvasResult(
    doc,
    'video',
    'b',
    { data: { video: { taskId: 'b', outputIndex: 0 } } },
    origin,
  )
  finishing.get('a')!()
  await vi.waitFor(() => expect(finishing.has('b')).toBe(true))
  expect(socket.sent).toHaveLength(sent)
  finishing.get('b')!()
  await vi.waitFor(() => expect(socket.sent.length).toBeGreaterThan(sent))
  Y.applyUpdate(server, readCanvasSyncMessage(socket.sent[socket.sent.length - 1]!).value)
  socket.receive(canvasSyncAck(server))
  expect(session.getSnapshot().status).toBe('saved')
  expect(canvasResults(server).every((r) => r.display?.video?.mediaId)).toBe(true)
  record.dispose()
})

it('projects posterless videos and unfinished shots for timeline preview and source navigation', async () => {
  const { session, record } = await fixture()
  const canvas = session.canvas!
  insertCanvasNode(
    canvas.doc,
    {
      id: 'posterless',
      type: 'video',
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      data: { video: { taskId: 'posterless-task', outputIndex: 0 } },
    },
    canvas.origin,
  )
  insertCanvasNode(
    canvas.doc,
    {
      id: 'future',
      type: 'image',
      x: 400,
      y: 0,
      width: 320,
      height: 180,
      data: { meta: { nodeKind: 'video' } },
    },
    canvas.origin,
  )
  expect(record.editor.getElement('posterless')).toMatchObject({
    type: 'image',
    fileId: '',
    video: { taskId: 'posterless-task' },
  })
  expect(record.editor.getElement('future')).toMatchObject({
    type: 'image',
    fileId: '',
    meta: { nodeKind: 'video' },
  })
  deleteCanvasNode(canvas.doc, 'future', canvas.origin)
  expect(record.editor.getElement('future')).toBeUndefined()
  record.dispose()
})

it.each([
  false,
  true,
])('focuses a historical cloud result through its real Y.Doc without duplicate delivery (existing: %s)', async (existing) => {
  vi.mocked(artifactBitmap).mockClear()
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 64
      naturalHeight = 64
      onload: (() => void) | null = null
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    },
  )
  const artifactId = 'agent_historical-task_0'
  const { session, record } = await fixture(async (_project, _record, server) => {
    if (!existing) return
    insertCanvasNode(
      server,
      {
        id: artifactId,
        type: 'image',
        x: 4_000,
        y: 3_000,
        width: 360,
        height: 240,
        data: { mediaId: '11111111-1111-4111-8111-111111111111' },
      },
      origin,
    )
  })
  const canvas = session.canvas!
  const sink = createAgentCanvasSink(record.editor, session.load(), {
    enabled: () => true,
    refresh: () => session.refresh(),
  })
  setAgentCanvasSink(sink)
  const focused: string[][] = []
  const unregister = registerNodeCanvasFocus(
    record.editor,
    (ids) => {
      const present = ids.filter((id) => canvas.doc.getMap('nodes').has(id))
      if (!present.length) return false
      focused.push(present)
      return true
    },
    () => false,
  )
  const message: AgentToolMessage = {
    kind: 'tool',
    id: 'historical-tool',
    turnId: 'historical-turn',
    toolCallId: 'historical-call',
    toolName: 'generateImage',
    title: '小狗',
    status: 'succeeded',
    artifacts: [
      {
        artifactId,
        taskId: 'historical-task',
        media: 'image',
        outputIndex: 0,
        mime: 'image/png',
      },
    ],
  }
  try {
    const changed = vi.fn()
    const delivery = createArtifactDelivery(changed)
    await delivery.restore([message])
    expect(artifactBitmap).not.toHaveBeenCalled()
    await delivery.placeOnCanvas(message)
    expect(changed).toHaveBeenLastCalledWith(message.id, 'placed')
    const nodes = readCanvasDocument(canvas.doc).nodes
    expect(nodes.filter((node) => node.id === artifactId)).toHaveLength(1)
    expect(record.editor.getElement(artifactId)).toMatchObject({ type: 'image' })
    expect(focused).toEqual([[artifactId]])
    if (existing)
      expect(nodes.find((node) => node.id === artifactId)).toMatchObject({
        x: 4_000,
        y: 3_000,
      })

    await delivery.placeOnCanvas(message)
    expect(readCanvasDocument(canvas.doc).nodes).toEqual(nodes)
    expect(focused).toEqual([[artifactId], [artifactId]])
    expect(artifactBitmap).toHaveBeenCalledTimes(existing ? 0 : 1)
    expect(await sink.syncArtifacts!(message.artifacts!)).toBe('placed')
  } finally {
    unregister()
    setAgentCanvasSink(null)
    record.dispose()
  }
})

it('does not add a rejected deferred image to either the editor or cloud node document', async () => {
  const { session, record } = await fixture()
  const canvas = session.canvas!
  const before = readCanvasDocument(canvas.doc)
  const sink = createAgentCanvasSink(record.editor, session.load(), {
    enabled: () => true,
    refresh: () => session.refresh(),
  })
  const ids = await sink.reserve({ count: 1, media: 'image', messageId: 'refused-image' })
  sink.markFailed(ids, 'Invalid parameters', 'invalid_params')
  expect(record.editor.getPlaceholders()).toEqual([])
  expect(readCanvasDocument(canvas.doc)).toEqual(before)
  record.dispose()
})

it('keeps a reserved cloud video in the node document when submission is rejected', async () => {
  const { session, record } = await fixture()
  const canvas = session.canvas!
  const sink = createAgentCanvasSink(record.editor, session.load(), {
    enabled: () => true,
    refresh: () => session.refresh(),
  })
  const ids = await sink.reserve({ count: 1, media: 'video', messageId: 'refused-video' })
  const node = () => readCanvasDocument(canvas.doc).nodes.find((one) => one.id === ids[0])
  expect(node()?.data).toMatchObject({ pending: { status: 'loading' } })
  sink.markFailed(ids, 'Invalid parameters', 'invalid_params')
  expect(node()?.data).toMatchObject({
    pending: { status: 'error', meta: { agentErrorCode: 'invalid_params' } },
  })
  expect(record.editor.getPlaceholder(ids[0]!)?.status).toBe('error')
  record.dispose()
})
