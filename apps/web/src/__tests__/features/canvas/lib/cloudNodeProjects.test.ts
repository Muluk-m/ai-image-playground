// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import {
  canvasOrigin,
  canvasSyncAck,
  canvasSyncStep1,
  canvasSyncUpdate,
  importLegacyElements,
  insertCanvasNode,
  moveCanvasNodes,
  readCanvasDocument,
  readCanvasSyncMessage,
} from '@image-playground/shared'
import { afterEach, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { CloudNodeProjectSession } from '../../../../features/canvas/lib/cloudNodeProjects'
import { getCloudProject, ProjectRequestError } from '../../../../features/canvas/lib/projectClient'
import { projectRepository } from '../../../../features/canvas/lib/projectRepository'
import { authenticatedBffFetch } from '../../../../lib/authClient'
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Socket.instances = []
})
async function fixture() {
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
  vi.mocked(authenticatedBffFetch).mockImplementation(
    async () => new Response(new Uint8Array(Y.encodeStateAsUpdate(server)).buffer),
  )
  vi.stubGlobal('WebSocket', Socket)
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
it('uses the server migration and does not start a second JSON cloud writer', async () => {
  const { session, record, socket, server } = await fixture()
  expect(readCanvasDocument(session.canvas!.doc).nodes[0]).toMatchObject({ id: 'text', x: 1, y: 2 })
  expect(record.editor.doc.elements[0]).toMatchObject({ id: 'text', text: 'Old' })
  expect(session.getSnapshot().status).toBe('syncing')
  socket.receive(canvasSyncAck(server))
  expect(session.getSnapshot().status).toBe('saved')
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

it('refresh waits for the fetched document to reach the legacy editor', async () => {
  const { session, record, server } = await fixture()
  moveCanvasNodes(server, [{ id: 'text', x: 909, y: 808 }], origin)
  await session.refresh()
  expect(record.editor.doc.elements[0]).toMatchObject({ x: 909, y: 808 })
  record.dispose()
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
