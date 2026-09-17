// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CloudProjectSession } from '../../../../features/canvas/lib/cloudProjects'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { loadScene, saveScene } from '../../../../features/canvas/lib/persistence'
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

it('新设备先恢复图片布局和稳定身份，打开项目不批量下载原图，拖动只更新结构', async () => {
  setClientStorageScope(crypto.randomUUID())
  const mediaId = crypto.randomUUID()
  const image = {
    id: 'image',
    type: 'image',
    mediaId,
    x: 20,
    y: 30,
    width: 320,
    height: 240,
    rotation: 0,
    name: '产品',
    groupId: 'set',
    naturalWidth: 3200,
    naturalHeight: 2400,
    meta: { prompt: '一张产品图' },
  }
  const remote = {
    id: crypto.randomUUID(),
    name: '图片画布',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    elementCount: 1,
    document: { version: 1, elements: [image] },
  }
  const requests: { url: string; body?: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: init?.body && JSON.parse(init.body as string) })
      return Response.json(
        init?.method === 'PUT' ? receipt(remote.id, JSON.parse(init.body as string)) : remote,
      )
    }),
  )
  const project = await projectRepository.importCloud(remote)
  const editor = new CanvasEditor(new CanvasDoc())
  const session = new CloudProjectSession(project, editor)
  await session.load()
  expect(session.getSnapshot().status).toBe('saved')
  expect(editor.doc.elements[0]).toMatchObject({
    id: 'image',
    name: '产品',
    groupId: 'set',
    x: 20,
    y: 30,
    naturalWidth: 3200,
  })
  const restoredImage = editor.doc.elements[0]!
  expect(restoredImage.type === 'image' && editor.doc.files[restoredImage.fileId]).toBe(
    `aip-media:${mediaId}`,
  )
  expect(requests).toHaveLength(1)
  editor.doc.updateElements([{ id: 'image', patch: { x: 80 } }])
  await session.sync()
  expect(requests).toHaveLength(2)
  expect(requests[1]!.body).toMatchObject({ document: { elements: [{ ...image, x: 80 }] } })
  expect(JSON.stringify(requests[1]!.body)).not.toContain('data:')
  expect(session.getSnapshot().status).toBe('saved')
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

it('本机原图确认上传后才保存云端结构，拖动不重复上传且保留本机原件', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { project, editor } = await fresh()
  const mediaId = crypto.randomUUID()
  const source = 'data:image/png;base64,AQID'
  editor.doc.addElements(
    [
      {
        id: 'photo',
        type: 'image',
        fileId: 'original',
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        rotation: 0,
      },
    ],
    { files: { original: source } },
  )
  const urls: string[] = []
  let confirmed = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url)
      if (url === source)
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      if (url.endsWith('/uploads'))
        return Response.json({
          id: mediaId,
          status: 'pending',
          uploadUrl: 'https://media.example/upload',
        })
      if (url === 'https://media.example/upload') return new Response(null)
      if (url.endsWith('/complete')) {
        confirmed = true
        return Response.json({ id: mediaId, status: 'ready' })
      }
      expect(confirmed).toBe(true)
      const body = JSON.parse(init!.body as string)
      expect(body.document.elements[1]).toMatchObject({ type: 'image', mediaId })
      expect(body.document.elements[1]).not.toHaveProperty('fileId')
      return Response.json(receipt(project.id, body))
    }),
  )
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  expect(session.getSnapshot().status).toBe('saved')
  expect(editor.doc.files.original).toBe(source)
  editor.doc.updateElements([{ id: 'photo', patch: { x: 200 } }])
  await session.sync()
  expect(session.getSnapshot().status).toBe('saved')
  expect(urls.filter((url) => url === 'https://media.example/upload')).toHaveLength(1)
  expect(urls.filter((url) => url.endsWith('/uploads'))).toHaveLength(1)
  session.dispose()
  const saved = await import('../../../../features/canvas/lib/persistence').then((module) =>
    module.readPersistedScene(project.sceneKey),
  )
  const nextImage = {
    id: 'photo',
    type: 'image',
    mediaId,
    x: 400,
    y: 20,
    width: 30,
    height: 40,
    rotation: 0,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === source
        ? new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
        : Response.json({
            id: project.id,
            name: '其他设备修改',
            revision: 3,
            createdAt: 1,
            updatedAt: 3000,
            elementCount: 2,
            document: { version: 1, elements: [saved!.elements[0], nextImage] },
          }),
    ),
  )
  const reopened = new CanvasEditor(new CanvasDoc())
  const next = new CloudProjectSession(project, reopened)
  await next.load(true)
  expect(reopened.doc.elements[1]).toMatchObject({ x: 400, fileId: 'original' })
  expect(reopened.doc.files.original).toBe(source)
  const retained = await import('../../../../features/canvas/lib/persistence').then((module) =>
    module.readPersistedScene(project.sceneKey),
  )
  expect(retained?.files.original).toBe(source)
  expect(retained?.cloud?.media?.original.id).toBe(mediaId)
  expect(next.getSnapshot().status).toBe('saved')
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
  expect(session.getSnapshot().status).toBe('load-error')
  await expect(session.sync()).rejects.toThrow('project_not_loaded')
})

it.each([0, 3])('图片未上传时保留本地场景，即使云端已有修订 %s', async (revision) => {
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
  await saveScene(editor, project.sceneKey)
  const session = new CloudProjectSession({ ...project, cloud: { revision } }, editor)
  await session.load(true)
  expect(session.getSnapshot().status).toBe('error')
  expect(fetcher.mock.calls.every((call) => String(call[0]).startsWith('data:'))).toBe(true)
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

it('旧标签页仅平移后刷新不能借用新修订覆盖另一标签页的内容', async () => {
  const { project, editor } = await fresh()
  let remote = {
    ...receipt(project.id, {
      name: project.name,
      baseRevision: 0,
      document: { elements: editor.doc.elements as unknown[] },
    }),
    document: { version: 1, elements: structuredClone(editor.doc.elements) },
  }
  let writes = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method !== 'PUT') return Response.json(remote)
      const body = JSON.parse(init.body as string)
      writes++
      remote = { ...receipt(project.id, body), document: body.document }
      return Response.json(remote)
    }),
  )
  const existing = { ...project, cloud: { revision: 1 } }
  const first = new CloudProjectSession(existing, editor)
  await first.load()
  const oldEditor = new CanvasEditor(new CanvasDoc())
  await loadScene(oldEditor, project.sceneKey)
  const oldTab = new CloudProjectSession(existing, oldEditor)
  await oldTab.load(true)
  editor.doc.updateElements([{ id: 'note', patch: { text: '另一标签页的新内容' } }], {
    history: true,
  })
  await first.sync()
  oldEditor.doc.setCamera({ x: 456 })
  await oldTab.saveLocal(true)
  await oldTab.sync()
  const restored = new CanvasEditor(new CanvasDoc())
  await loadScene(restored, project.sceneKey)
  const reopened = new CloudProjectSession(existing, restored)
  await reopened.load(true)
  expect(restored.doc.elements[0]).toMatchObject({ text: '另一标签页的新内容' })
  expect(writes).toBe(1)
})

it('云端读取成功但本机落盘失败后重试读取，不上传旧缓存', async () => {
  const { project, editor } = await fresh()
  let remote = {
    ...receipt(project.id, {
      name: project.name,
      baseRevision: 0,
      document: { elements: editor.doc.elements as unknown[] },
    }),
    document: { version: 1, elements: structuredClone(editor.doc.elements) },
  }
  let writes = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'PUT') {
        writes++
        const body = JSON.parse(init.body as string)
        return Response.json(receipt(project.id, body))
      }
      return Response.json(remote)
    }),
  )
  const existing = { ...project, cloud: { revision: 1 } }
  await new CloudProjectSession(existing, editor).load()
  remote = {
    ...remote,
    revision: 2,
    document: {
      version: 1,
      elements: [
        { ...remote.document.elements[0], text: '云端新稿' },
      ] as typeof remote.document.elements,
    },
  }
  const secondEditor = new CanvasEditor(new CanvasDoc())
  await loadScene(secondEditor, project.sceneKey)
  const second = new CloudProjectSession(existing, secondEditor)
  const originalPut = IDBObjectStore.prototype.put
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['put']>
  ) {
    const result = originalPut.apply(this, args)
    if (args[1] === project.sceneKey) this.transaction.abort()
    return result
  })
  await expect(second.load(true)).rejects.toThrow()
  spy.mockRestore()
  await loadScene(secondEditor, project.sceneKey)
  await second.load(true)
  expect(secondEditor.doc.elements[0]).toMatchObject({ text: '云端新稿' })
  expect(writes).toBe(0)
})

it('本地模式保存保留云端基线，重新启用后不覆盖未同步修改', async () => {
  const { project, editor } = await fresh()
  const initial = {
    ...receipt(project.id, {
      name: project.name,
      baseRevision: 0,
      document: { elements: editor.doc.elements as unknown[] },
    }),
    document: { version: 1, elements: structuredClone(editor.doc.elements) },
  }
  const saved: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'PUT') {
        const body = JSON.parse(init.body as string)
        saved.push(body)
        return Response.json(receipt(project.id, body))
      }
      return Response.json(initial)
    }),
  )
  const existing = { ...project, cloud: { revision: 1 } }
  await new CloudProjectSession(existing, editor).load()
  editor.doc.updateElements([{ id: 'note', patch: { text: '关闭同步期间的修改' } }], {
    history: true,
  })
  await saveScene(editor, project.sceneKey)
  const restored = new CanvasEditor(new CanvasDoc())
  await loadScene(restored, project.sceneKey)
  await new CloudProjectSession(existing, restored).load(true)
  expect(restored.doc.elements[0]).toMatchObject({ text: '关闭同步期间的修改' })
  expect(saved).toHaveLength(1)
  expect(saved[0]).toMatchObject({ baseRevision: 1 })
})
