// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CloudProjectSession } from '../../../../features/canvas/lib/cloudProjects'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { loadScene } from '../../../../features/canvas/lib/persistence'
import { projectRepository } from '../../../../features/canvas/lib/projectRepository'
import { setClientStorageScope } from '../../../../lib/authScope'

afterEach(() => {
  vi.unstubAllGlobals()
  setClientStorageScope(null)
})

it('新设备打开云端文字画布，恢复名称与标注；相机和选区变动不写云端', async () => {
  setClientStorageScope(crypto.randomUUID())
  const remote = {
    id: crypto.randomUUID(),
    name: '跨设备海报',
    revision: 3,
    createdAt: 1000,
    updatedAt: 3000,
    elementCount: 1,
    document: {
      version: 1,
      elements: [
        {
          id: 'text',
          type: 'text',
          x: 50,
          y: 80,
          text: '夏日',
          fontSize: 64,
          fill: '#ef4444',
          width: 160,
          height: 80,
        },
      ],
    },
  }
  const fetcher = vi.fn(() => Promise.resolve(Response.json(remote)))
  vi.stubGlobal('fetch', fetcher)
  const project = await projectRepository.importCloud(remote)
  const editor = new CanvasEditor(new CanvasDoc())
  const session = new CloudProjectSession(project, editor)
  await session.load()
  expect(editor.doc.elements).toEqual(remote.document.elements)
  expect(session.getSnapshot().status).toBe('saved')
  editor.doc.setCamera({ x: 123, zoom: 2 })
  editor.doc.setSelection(['text'])
  await session.sync()
  expect(fetcher.mock.calls).toHaveLength(1)
  expect((await projectRepository.list())[0].name).toBe('跨设备海报')
})

async function fresh() {
  setClientStorageScope(crypto.randomUUID())
  const project = await projectRepository.create('本机编辑', undefined, true)
  const editor = new CanvasEditor(new CanvasDoc())
  editor.doc.addElements([
    {
      id: 'note',
      type: 'text',
      x: 20,
      y: 40,
      text: '本机原稿',
      fontSize: 48,
      fill: '#ef4444',
      width: 200,
      height: 50,
    },
  ])
  return { project, editor }
}
const receipt = (
  id: string,
  body: { name: string; baseRevision: number; document: { elements: unknown[] } },
) => ({
  id,
  name: body.name,
  revision: body.baseRevision + 1,
  elementCount: body.document.elements.length,
  createdAt: 1000,
  updatedAt: 2000,
})

it('读取错误保留原画布，重试成功前不发送空文档', async () => {
  const { project, editor } = await fresh()
  const fetcher = vi.fn(() =>
    Promise.resolve(Response.json({ error: 'unavailable' }, { status: 503 })),
  )
  vi.stubGlobal('fetch', fetcher)
  const session = new CloudProjectSession({ ...project, cloud: { revision: 1 } }, editor)
  await expect(session.load(true)).rejects.toThrow()
  expect(editor.doc.elements[0]).toMatchObject({ text: '本机原稿' })
  expect(fetcher.mock.calls).toHaveLength(1)
  expect(session.getSnapshot().status).toBe('error')
})

it('图片未上传时不提交残缺场景，也不报告完整同步', async () => {
  const { project, editor } = await fresh()
  editor.doc.addElements(
    [
      {
        id: 'photo',
        type: 'image',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        rotation: 0,
        fileId: 'local',
      },
    ],
    { files: { local: 'data:image/png;base64,AAAA' } },
  )
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  expect(session.getSnapshot().status).toBe('media-local')
  expect(fetcher).not.toHaveBeenCalled()
  expect(editor.doc.elements).toHaveLength(2)
})

it('提交响应丢失后刷新重试同一请求身份，不重复提交版本', async () => {
  const { project, editor } = await fresh()
  const bodies: {
    requestId: string
    name: string
    baseRevision: number
    document: { elements: unknown[] }
  }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      bodies.push(body)
      if (bodies.length === 1) throw new Error('response lost')
      return Response.json(receipt(project.id, body))
    }),
  )
  const first = new CloudProjectSession(project, editor)
  await first.load(true)
  expect(first.getSnapshot().status).toBe('error')
  first.dispose()
  const restored = new CanvasEditor(new CanvasDoc())
  await loadScene(restored, project.sceneKey)
  const second = new CloudProjectSession(project, restored)
  await second.load(true)
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toEqual(bodies[0])
  expect(second.getSnapshot().status).toBe('saved')
})

it('收到冲突后停写，刷新后仍保留本机原稿', async () => {
  const { project, editor } = await fresh()
  const fetcher = vi.fn(() =>
    Promise.resolve(Response.json({ error: 'project_conflict', revision: 2 }, { status: 409 })),
  )
  vi.stubGlobal('fetch', fetcher)
  const first = new CloudProjectSession(project, editor)
  await first.load(true)
  await first.sync()
  const restored = new CanvasEditor(new CanvasDoc())
  await loadScene(restored, project.sceneKey)
  const second = new CloudProjectSession(project, restored)
  await second.load(true)
  expect(second.getSnapshot().status).toBe('conflict')
  expect(restored.doc.elements[0]).toMatchObject({ text: '本机原稿' })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('较早确认不能把同步期间的新编辑标成已同步', async () => {
  const { project, editor } = await fresh()
  let finish: (response: Response) => void = () => {}
  let sent: Parameters<typeof receipt>[1] | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string)
      return new Promise<Response>((resolve) => {
        finish = resolve
      })
    }),
  )
  const session = new CloudProjectSession(project, editor)
  const loading = session.load(true)
  await vi.waitFor(() => expect(sent).toBeDefined())
  editor.doc.updateElements([{ id: 'note', patch: { text: '请求期间的新稿' } }], { history: true })
  session.markChanged()
  finish(Response.json(receipt(project.id, sent!)))
  await loading
  expect(session.getSnapshot().status).toBe('pending')
  expect(editor.doc.elements[0]).toMatchObject({ text: '请求期间的新稿' })
})
