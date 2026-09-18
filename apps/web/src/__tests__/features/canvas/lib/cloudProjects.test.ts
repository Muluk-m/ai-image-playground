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
  await expect(session.sync()).rejects.toThrow('unavailable')
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

it('已缓存云端画布断网后仍可编辑，刷新保留修改，联网才确认云端保存', async () => {
  const { project, editor } = await fresh()
  const writes: Parameters<typeof receipt>[1][] = []
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    writes.push(body)
    return Response.json(receipt(project.id, body))
  })
  vi.stubGlobal('fetch', fetcher)
  const first = new CloudProjectSession(project, editor)
  await first.load(true)
  first.dispose()
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  const local = new CanvasEditor(new CanvasDoc())
  const offline = new CloudProjectSession(project, local)
  await offline.load(true)
  expect(offline.getSnapshot().status).toBe('offline')
  local.doc.updateElements([{ id: 'note', patch: { text: '离线修改' } }])
  offline.markChanged()
  expect(await offline.saveLocal()).toBe(true)
  await offline.sync()
  expect(writes).toHaveLength(1)
  offline.dispose()
  const reopenedEditor = new CanvasEditor(new CanvasDoc())
  const reopened = new CloudProjectSession(project, reopenedEditor)
  await reopened.load(true)
  expect(reopenedEditor.doc.elements[0]).toMatchObject({ text: '离线修改' })
  expect(reopened.getSnapshot().status).toBe('offline')
  online.mockReturnValue(true)
  await reopened.sync()
  expect(writes).toHaveLength(2)
  expect(writes[1]).toMatchObject({
    baseRevision: 1,
    document: { elements: [{ text: '离线修改' }] },
  })
  expect(reopened.getSnapshot().status).toBe('saved')
  reopened.dispose()
  online.mockRestore()
})

it('联网事件自动续传离线修改，重复事件不会重复上传', async () => {
  const { project, editor } = await fresh()
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
  const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
    Response.json(receipt(project.id, JSON.parse(init.body as string))),
  )
  vi.stubGlobal('fetch', fetcher)
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  session.start()
  expect(fetcher).not.toHaveBeenCalled()
  online.mockReturnValue(true)
  window.dispatchEvent(new Event('online'))
  window.dispatchEvent(new Event('online'))
  await vi.waitFor(() => expect(session.getSnapshot().status).toBe('saved'), { timeout: 3000 })
  expect(fetcher).toHaveBeenCalledTimes(1)
  session.dispose()
  online.mockRestore()
})

it('网络故障有限退避五次，手动重试仍沿用原请求身份', async () => {
  const { project, editor } = await fresh()
  const requests: { requestId: string }[] = []
  let available = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      requests.push(body)
      if (!available) return Response.json({ error: 'unavailable' }, { status: 503 })
      return Response.json(receipt(project.id, body))
    }),
  )
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  try {
    session.start()
    for (const [index, delay] of [1000, 2000, 5000, 15000, 30000].entries()) {
      await vi.advanceTimersByTimeAsync(delay)
      await vi.waitFor(() => expect(requests).toHaveLength(index + 2))
      await vi.waitFor(() => expect(session.getSnapshot().status).toBe('error'))
    }
    await vi.advanceTimersByTimeAsync(300000)
    expect(requests).toHaveLength(6)
    available = true
    await session.sync()
    expect(session.getSnapshot().status).toBe('saved')
    expect(new Set(requests.map((request) => request.requestId)).size).toBe(1)
  } finally {
    session.dispose()
    vi.useRealTimers()
  }
})

it.each([
  [401, 'auth-error'],
  [403, 'permission-error'],
  [404, 'permission-error'],
  [413, 'quota-error'],
  [422, 'format-error'],
  [400, 'format-error'],
])('不可自动修复的 %s 错误单独提示且停写', async (status, expected) => {
  const { project, editor } = await fresh()
  const fetcher = vi.fn(async () =>
    Response.json({ error: 'rejected' }, { status: Number(status) }),
  )
  vi.stubGlobal('fetch', fetcher)
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  try {
    session.start()
    expect(session.getSnapshot().status).toBe(expected)
    window.dispatchEvent(new Event('online'))
    editor.doc.updateElements([{ id: 'note', patch: { text: '继续保留在本机' } }])
    session.markChanged()
    await session.saveLocal()
    await vi.advanceTimersByTimeAsync(300000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(session.getSnapshot().status).toBe(expected)
    const restored = new CanvasEditor(new CanvasDoc())
    await loadScene(restored, project.sceneKey)
    expect(restored.doc.elements[0]).toMatchObject({ text: '继续保留在本机' })
  } finally {
    session.dispose()
    vi.useRealTimers()
  }
})

it('本机写入失败单独提示，不把未持久化的修改发到云端', async () => {
  const { project, editor } = await fresh()
  const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
    Response.json(receipt(project.id, JSON.parse(init.body as string))),
  )
  vi.stubGlobal('fetch', fetcher)
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  editor.doc.updateElements([{ id: 'note', patch: { text: '尚未落盘' } }])
  session.markChanged()
  const originalPut = IDBObjectStore.prototype.put
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['put']>
  ) {
    const result = originalPut.apply(this, args)
    if (args[1] === project.sceneKey) this.transaction.abort()
    return result
  })
  try {
    expect(await session.saveLocal()).toBe(false)
    expect(session.getSnapshot().status).toBe('local-error')
    await session.sync()
    expect(fetcher).toHaveBeenCalledTimes(1)
  } finally {
    spy.mockRestore()
  }
  expect(await session.saveLocal()).toBe(true)
  expect(session.getSnapshot().status).toBe('local')
  await session.sync()
  expect(session.getSnapshot().status).toBe('saved')
  session.dispose()
})

it('一轮连续编辑合并为一次后台写入，只发送最后的画布状态', async () => {
  const { project, editor } = await fresh()
  const bodies: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      bodies.push(body)
      return Response.json(receipt(project.id, body))
    }),
  )
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  try {
    session.start()
    for (let index = 1; index <= 10; index++) {
      editor.doc.updateElements([{ id: 'note', patch: { x: index * 10 } }])
      session.markChanged()
      await session.saveLocal()
      session.requestSync()
    }
    expect(bodies).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(session.getSnapshot().status).toBe('saved'))
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toMatchObject({ document: { elements: [{ x: 100 }] } })
  } finally {
    session.dispose()
    vi.useRealTimers()
  }
})

it('浏览器显示在线但 API 暂不可达时，已缓存项目仍可编辑并在恢复后续传', async () => {
  const { project, editor } = await fresh()
  const writes: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method !== 'PUT') throw new TypeError('Failed to fetch')
      const body = JSON.parse(init.body as string)
      writes.push(body)
      return Response.json(receipt(project.id, body))
    }),
  )
  const first = new CloudProjectSession(project, editor)
  await first.load(true)
  first.dispose()
  const nextEditor = new CanvasEditor(new CanvasDoc())
  const second = new CloudProjectSession(project, nextEditor)
  await second.load(true)
  expect(second.getSnapshot().status).toBe('error')
  expect(nextEditor.doc.elements[0]).toMatchObject({ text: '本机原稿' })
  nextEditor.doc.updateElements([{ id: 'note', patch: { text: '网络故障期间的新稿' } }])
  second.markChanged()
  await second.saveLocal()
  await second.sync()
  expect(second.getSnapshot().status).toBe('saved')
  expect(writes).toHaveLength(2)
  expect(writes[1]).toMatchObject({
    baseRevision: 1,
    document: { elements: [{ text: '网络故障期间的新稿' }] },
  })
  second.dispose()
})

it('检查远端期间发生的新编辑不能被较晚的 GET 覆盖', async () => {
  const { project, editor } = await fresh()
  let finish: (value: Response) => void = () => {}
  let reading = false
  let writes = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method !== 'PUT') {
        reading = true
        return new Promise<Response>((resolve) => {
          finish = resolve
        })
      }
      const body = JSON.parse(init.body as string)
      writes++
      return writes === 1
        ? Response.json(receipt(project.id, body))
        : Response.json({ error: 'project_conflict' }, { status: 409 })
    }),
  )
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  const loading = session.load(true)
  await vi.waitFor(() => expect(reading).toBe(true))
  editor.doc.updateElements([{ id: 'note', patch: { text: '读取期间编辑的稿件' } }])
  session.markChanged()
  finish(
    Response.json({
      id: project.id,
      name: project.name,
      revision: 2,
      createdAt: 1,
      updatedAt: 2,
      elementCount: 0,
      document: { version: 1, elements: [] },
    }),
  )
  await loading
  expect(editor.doc.elements[0]).toMatchObject({ text: '读取期间编辑的稿件' })
  expect(session.getSnapshot().status).toBe('conflict')
  const restored = new CanvasEditor(new CanvasDoc())
  await loadScene(restored, project.sceneKey)
  expect(restored.doc.elements[0]).toMatchObject({ text: '读取期间编辑的稿件' })
  session.dispose()
})

it('重复打开或恢复可见时五秒内至多检查一次远端', async () => {
  const { project, editor } = await fresh()
  let reads = 0
  let remote: unknown
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'PUT') {
        const body = JSON.parse(init.body as string)
        remote = { ...receipt(project.id, body), document: body.document }
      } else reads++
      return Response.json(remote)
    }),
  )
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  try {
    await session.refresh()
    expect(reads).toBe(0)
    await vi.advanceTimersByTimeAsync(5000)
    await Promise.all(Array.from({ length: 20 }, () => session.refresh()))
    expect(reads).toBe(1)
    await vi.advanceTimersByTimeAsync(5000)
    await session.refresh()
    expect(reads).toBe(2)
  } finally {
    session.dispose()
    vi.useRealTimers()
  }
})

it('同时恢复多个项目时最多两条同步链占用网络', async () => {
  setClientStorageScope(crypto.randomUUID())
  let active = 0
  let peak = 0
  const finish: (() => void)[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => {
      active++
      peak = Math.max(peak, active)
      const body = JSON.parse(init.body as string)
      const id = url.slice(url.lastIndexOf('/') + 1)
      return new Promise<Response>((resolve) =>
        finish.push(() => {
          active--
          resolve(Response.json(receipt(id, body)))
        }),
      )
    }),
  )
  const projects = await Promise.all(
    Array.from({ length: 4 }, () => projectRepository.create('并发项目', undefined, true)),
  )
  const sessions = projects.map(
    (project) => new CloudProjectSession(project, new CanvasEditor(new CanvasDoc())),
  )
  const loading = sessions.map((session) => session.load(true))
  try {
    await vi.waitFor(() => expect(finish.length).toBeGreaterThanOrEqual(2))
    expect(peak).toBe(2)
    while (finish.length) {
      finish.shift()!()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await Promise.all(loading)
    expect(peak).toBe(2)
    expect(sessions.every((session) => session.getSnapshot().status === 'saved')).toBe(true)
  } finally {
    for (const resolve of finish) resolve()
    for (const session of sessions) session.dispose()
    await Promise.allSettled(loading)
  }
})

it('切换账号后迟到的确认不清除原账号待同步批次，也不写新账号', async () => {
  const { project, editor } = await fresh()
  let finish: (value: Response) => void = () => {}
  let body: Parameters<typeof receipt>[1] | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string)
      return new Promise<Response>((resolve) => {
        finish = resolve
      })
    }),
  )
  const session = new CloudProjectSession(project, editor)
  const loading = session.load(true)
  const settled = loading.catch((error) => error)
  await vi.waitFor(() => expect(body).toBeDefined())
  setClientStorageScope(crypto.randomUUID())
  const other = await projectRepository.create('另一个账号', undefined, true)
  finish(Response.json(receipt(project.id, body!)))
  expect(await settled).toMatchObject({ message: 'project_scope_changed' })
  const { readPersistedScene } = await import('../../../../features/canvas/lib/persistence')
  expect((await readPersistedScene(project.sceneKey))?.cloud?.pending).toMatchObject({
    baseRevision: 0,
  })
  expect(await readPersistedScene(other.sceneKey)).toBeUndefined()
  expect((await projectRepository.list()).map((item) => item.id)).toEqual([other.id])
  session.dispose()
})

it.each([
  [401, 'auth-error'],
  [403, 'permission-error'],
  [404, 'permission-error'],
  [413, 'quota-error'],
  [422, 'format-error'],
])('读取项目的 %s 错误保留独立分类且不允许盲写', async (status, expected) => {
  const { project, editor } = await fresh()
  const fetcher = vi.fn(async () =>
    Response.json({ error: 'rejected' }, { status: Number(status) }),
  )
  vi.stubGlobal('fetch', fetcher)
  const session = new CloudProjectSession({ ...project, cloud: { revision: 1 } }, editor)
  await expect(session.load(true)).rejects.toThrow()
  expect(session.getSnapshot().status).toBe(expected)
  await expect(session.sync()).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(2)
  session.dispose()
})

it('后台读取被拒后继续编辑，权限恢复重试不会用旧云端内容覆盖本机新稿', async () => {
  const { project, editor } = await fresh()
  let allowed = true
  let remote: unknown
  const writes: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      if (!allowed) return Response.json({ error: 'forbidden' }, { status: 403 })
      if (init.method === 'PUT') {
        const body = JSON.parse(init.body as string)
        writes.push(body)
        remote = { ...receipt(project.id, body), document: body.document }
      }
      return Response.json(remote)
    }),
  )
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  allowed = false
  await expect(session.load(true)).rejects.toThrow()
  editor.doc.updateElements([{ id: 'note', patch: { text: '权限恢复前保留的新稿' } }])
  session.markChanged()
  await session.saveLocal()
  allowed = true
  await session.sync()
  expect(editor.doc.elements[0]).toMatchObject({ text: '权限恢复前保留的新稿' })
  expect(writes).toHaveLength(2)
  expect(writes[1]).toMatchObject({
    baseRevision: 1,
    document: { elements: [{ text: '权限恢复前保留的新稿' }] },
  })
  expect(session.getSnapshot().status).toBe('saved')
  session.dispose()
})

it('使用云端版前保存可重新打开的独立本机副本，重复操作不重复建项目', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { project, editor } = await fresh()
  await projectRepository.update(project.id, { conversationId: 'original-conversation' })
  const remote = {
    ...receipt(project.id, { name: '云端新稿', baseRevision: 3, document: { elements: [] } }),
    document: { version: 1, elements: [] },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Response.json({ error: 'project_conflict' }, { status: 409 })
        : Response.json(remote),
    ),
  )
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  expect(session.getSnapshot().status).toBe('conflict')
  const copy = await session.resolveConflict('cloud')
  expect(copy?.id).not.toBe(project.id)
  expect(copy?.conversationId).toBeNull()
  const reopened = new CanvasEditor(new CanvasDoc())
  expect(await loadScene(reopened, copy!.sceneKey)).toBe(true)
  expect(reopened.doc.elements[0]).toMatchObject({ text: '本机原稿' })
  expect(editor.doc.elements).toEqual([])
  expect(session.getSnapshot().status).toBe('saved')
  await session.resolveConflict('cloud')
  expect(await projectRepository.list()).toHaveLength(2)
})

it('本机副本操作在刷新后重复也复用同一副本，后续新编辑另存且保留两稿', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { project, editor } = await fresh()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'project_conflict' }, { status: 409 })),
  )
  const first = new CloudProjectSession(project, editor)
  await first.load(true)
  const copy = await first.resolveConflict('copy')
  first.dispose()
  const reloaded = new CanvasEditor(new CanvasDoc())
  await loadScene(reloaded, project.sceneKey)
  const second = new CloudProjectSession(project, reloaded)
  await second.load(true)
  const again = await second.resolveConflict('copy')
  expect(again?.id).toBe(copy?.id)
  reloaded.doc.updateElements([{ id: 'note', patch: { text: '副本之后继续编辑' } }])
  second.markChanged()
  const newer = await second.resolveConflict('copy')
  expect(newer?.id).not.toBe(copy?.id)
  expect(await projectRepository.list()).toHaveLength(3)
})

it('恢复副本不接管原项目正在生成的占位任务或会话执行上下文', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { project, editor } = await fresh()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'project_conflict' }, { status: 409 })),
  )
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  editor.doc.addElements([
    {
      id: 'running',
      type: 'placeholder',
      x: 1,
      y: 2,
      width: 200,
      height: 120,
      status: 'loading',
      message: '生成中',
      meta: {
        taskId: 'task',
        clientRequestId: 'client',
        prompt: '新图片',
        source: 'builtin-edge',
        bffRequestId: 'original-job',
        agent: true,
      },
    },
  ])
  session.markChanged()
  const copy = await session.resolveConflict('copy')
  const restored = new CanvasEditor(new CanvasDoc())
  await loadScene(restored, copy!.sceneKey)
  expect(restored.doc.elements).toHaveLength(2)
  expect(restored.doc.elements[1]).toMatchObject({ type: 'text', text: '生成中\n新图片' })
  expect(JSON.stringify(restored.doc.elements)).not.toContain('original-job')
  expect(editor.doc.elements[1]).toMatchObject({ type: 'placeholder', status: 'loading' })
})

it('恢复副本事务中止时不替换原稿，刷新后仍可恢复并显示保存失败', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { project, editor } = await fresh()
  const remote = {
    ...receipt(project.id, { name: '云端', baseRevision: 2, document: { elements: [] } }),
    document: { version: 1, elements: [] },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Response.json({ error: 'project_conflict' }, { status: 409 })
        : Response.json(remote),
    ),
  )
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  const originalAdd = IDBObjectStore.prototype.add
  const fault = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['add']>
  ) {
    const request = originalAdd.apply(this, args)
    this.transaction.abort()
    return request
  })
  try {
    await expect(session.resolveConflict('cloud')).rejects.toBeDefined()
  } finally {
    fault.mockRestore()
  }
  expect(session.getSnapshot()).toMatchObject({
    status: 'conflict',
    message: 'errors:projectSync.recovery_copy_failed',
  })
  expect(editor.doc.elements[0]).toMatchObject({ text: '本机原稿' })
  const reopened = new CanvasEditor(new CanvasDoc())
  await loadScene(reopened, project.sceneKey)
  expect(reopened.doc.elements[0]).toMatchObject({ text: '本机原稿' })
  expect(await projectRepository.list()).toHaveLength(1)
})

it('已有副本被继续编辑后，再次解决原冲突会重新保全原稿', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { project, editor } = await fresh()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: 'project_conflict' }, { status: 409 })),
  )
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  const copy = await session.resolveConflict('copy')
  const copyEditor = new CanvasEditor(new CanvasDoc())
  await loadScene(copyEditor, copy!.sceneKey)
  copyEditor.doc.updateElements([{ id: 'note', patch: { text: '已改掉的副本内容' } }])
  await saveScene(copyEditor, copy!.sceneKey)
  const recovered = await session.resolveConflict('copy')
  expect(recovered?.id).not.toBe(copy?.id)
  const original = new CanvasEditor(new CanvasDoc())
  await loadScene(original, recovered!.sceneKey)
  expect(original.doc.elements[0]).toMatchObject({ text: '本机原稿' })
  await loadScene(copyEditor, copy!.sceneKey)
  expect(copyEditor.doc.elements[0]).toMatchObject({ text: '已改掉的副本内容' })
})

it.each([
  'cloud',
  'copy',
] as const)('恢复副本保存期间继续编辑时不替换新稿或跳离当前画布：%s', async (choice) => {
  vi.stubGlobal('crypto', webcrypto)
  const { project, editor } = await fresh()
  const remote = {
    ...receipt(project.id, { name: '云端', baseRevision: 2, document: { elements: [] } }),
    document: { version: 1, elements: [] },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Response.json({ error: 'project_conflict' }, { status: 409 })
        : Response.json(remote),
    ),
  )
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  const originalAdd = IDBObjectStore.prototype.add
  let edited = false
  const duringSave = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['add']>
  ) {
    if (!edited) {
      edited = true
      editor.doc.updateElements([{ id: 'note', patch: { text: '保存期间的新编辑' } }])
      session.markChanged()
    }
    return originalAdd.apply(this, args)
  })
  try {
    expect(await session.resolveConflict(choice)).toBeUndefined()
  } finally {
    duringSave.mockRestore()
  }
  expect(editor.doc.elements[0]).toMatchObject({ text: '保存期间的新编辑' })
  expect(session.getSnapshot()).toMatchObject({
    status: 'conflict',
    message: 'errors:projectSync.recovery_changed',
  })
  await session.saveLocal()
  const reopened = new CanvasEditor(new CanvasDoc())
  await loadScene(reopened, project.sceneKey)
  expect(reopened.doc.elements[0]).toMatchObject({ text: '保存期间的新编辑' })
})

it('采用云端稿落盘期间的新修改不能被标成已同步', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { project, editor } = await fresh()
  const remote = {
    ...receipt(project.id, { name: '云端', baseRevision: 2, document: { elements: [] } }),
    document: { version: 1, elements: [] },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Response.json({ error: 'project_conflict' }, { status: 409 })
        : Response.json(remote),
    ),
  )
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  const originalPut = IDBObjectStore.prototype.put
  let edited = false
  const duringSave = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['put']>
  ) {
    if (!edited && args[1] === project.sceneKey && args[0]?.cloud?.revision === 3) {
      edited = true
      editor.doc.addElements([
        {
          id: 'later',
          type: 'text',
          x: 0,
          y: 0,
          width: 80,
          height: 40,
          text: '采用云端后新编辑',
          fontSize: 24,
          fill: '#000',
        },
      ])
      session.markChanged()
    }
    return originalPut.apply(this, args)
  })
  try {
    await session.resolveConflict('cloud')
  } finally {
    duringSave.mockRestore()
  }
  expect(editor.doc.elements[0]).toMatchObject({ text: '采用云端后新编辑' })
  expect(session.getSnapshot().status).toBe('pending')
})

it.each([
  'sync',
  'rename',
] as const)('采用云端稿后项目索引写入失败仍可恢复且不覆盖新名称：%s', async (action) => {
  vi.stubGlobal('crypto', webcrypto)
  const { project, editor } = await fresh()
  const remote = {
    ...receipt(project.id, { name: '云端新名称', baseRevision: 2, document: { elements: [] } }),
    document: { version: 1, elements: [] },
  }
  let allowWrite = false
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'PUT'
      ? allowWrite
        ? Response.json(receipt(project.id, JSON.parse(init.body as string)))
        : Response.json({ error: 'project_conflict' }, { status: 409 })
      : Response.json(remote),
  )
  vi.stubGlobal('fetch', fetcher)
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  const originalPut = IDBObjectStore.prototype.put
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['put']>
  ) {
    const request = originalPut.apply(this, args)
    if (args[0]?.id === project.id && args[0]?.name === '云端新名称') this.transaction.abort()
    return request
  })
  try {
    await expect(session.resolveConflict('cloud')).rejects.toBeDefined()
  } finally {
    fault.mockRestore()
  }
  expect(session.getSnapshot().status).toBe('local-error')
  allowWrite = true
  if (action === 'rename') await session.rename('恢复后的新名称')
  await session.sync()
  expect(session.getSnapshot().status).toBe('saved')
  expect((await projectRepository.list()).find((one) => one.id === project.id)).toMatchObject({
    name: action === 'rename' ? '恢复后的新名称' : '云端新名称',
    cloud: { revision: action === 'rename' ? 4 : 3 },
  })
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(
    action === 'rename' ? 2 : 1,
  )
})

it('新设备恢复服务端生成占位，刷新不删除；移动只同步几何，不重提任务', async () => {
  setClientStorageScope(crypto.randomUUID())
  const generationId = '70cf33ea-d548-4a2b-ab0b-4a10e2e444fb'
  const id = `agent_${generationId}_0`
  const remote = {
    id: crypto.randomUUID(),
    name: '运行中的图片项目',
    revision: 2,
    createdAt: 1,
    updatedAt: 2,
    elementCount: 1,
    document: {
      version: 1,
      elements: [
        { id, type: 'generation', generationId, position: 0, x: 24, y: 0, width: 360, height: 360 },
      ],
    },
  }
  const writes: { document: { elements: unknown[] } }[] = []
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(init.body as string)
      writes.push(body)
      return Response.json(receipt(remote.id, body))
    }
    return Response.json(remote)
  })
  const project = await projectRepository.importCloud(remote)
  const editor = new CanvasEditor(new CanvasDoc())
  const session = new CloudProjectSession(project, editor)
  await session.load()
  expect(editor.doc.elements).toMatchObject([
    {
      id,
      type: 'placeholder',
      status: 'loading',
      meta: { cloudGeneration: { id: generationId, position: 0 } },
    },
  ])
  const { recoverCanvasTasks } = await import('../../../../features/canvas/lib/recoverCanvasTasks')
  recoverCanvasTasks(editor)
  expect(editor.doc.elements).toHaveLength(1)
  editor.doc.updateElements([{ id, patch: { x: 900 } }])
  await session.sync()
  expect(writes).toHaveLength(1)
  expect(writes[0].document.elements).toEqual([{ ...remote.document.elements[0], x: 900 }])
  session.dispose()
})

it('其他设备删除项目后停止旧身份上传，保留本机编辑并允许显式存为新项目', async () => {
  vi.stubGlobal('crypto', webcrypto)
  setClientStorageScope(crypto.randomUUID())
  const remote = {
    id: crypto.randomUUID(),
    name: '被删除的海报',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    elementCount: 0,
    document: { version: 1, elements: [] },
  }
  let deleted = false
  const fetcher = vi.fn(async () =>
    deleted ? Response.json({ error: 'project_deleted' }, { status: 410 }) : Response.json(remote),
  )
  vi.stubGlobal('fetch', fetcher)
  const project = await projectRepository.importCloud(remote)
  const editor = new CanvasEditor(new CanvasDoc())
  const session = new CloudProjectSession(project, editor)
  await session.load()
  editor.doc.addElements([
    {
      id: 'offline-text',
      type: 'text',
      x: 0,
      y: 0,
      width: 200,
      height: 60,
      text: '尚未上传的编辑',
      fontSize: 24,
      fill: '#000000',
    },
  ])
  session.markChanged()
  deleted = true
  await session.sync()
  expect(session.getSnapshot().status).toBe('deleted')
  const requests = fetcher.mock.calls.length
  await session.sync()
  expect(fetcher.mock.calls.length).toBe(requests)
  const copy = await session.resolveConflict('copy')
  expect(copy?.id).not.toBe(project.id)
  expect(copy?.cloud?.revision).toBe(0)
  const recovered = new CanvasEditor(new CanvasDoc())
  await loadScene(recovered, copy!.sceneKey)
  expect(recovered.doc.elements).toMatchObject([{ id: 'offline-text', text: '尚未上传的编辑' }])
  await projectRepository.update(copy!.id, { cloud: { revision: 1, deleted: true } })
  const nextCopy = await session.resolveConflict('copy')
  expect(nextCopy!.id).not.toBe(copy!.id)
  deleted = false
  remote.revision = 3
  await session.refresh(true)
  expect(session.getSnapshot().status).toBe('conflict')
  expect(editor.doc.elements).toMatchObject([{ id: 'offline-text', text: '尚未上传的编辑' }])
  session.dispose()
})

it('其他设备恢复项目后，已打开的删除状态会自动恢复同步', async () => {
  vi.stubGlobal('crypto', webcrypto)
  setClientStorageScope(crypto.randomUUID())
  const remote = {
    id: crypto.randomUUID(),
    name: '恢复的海报',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    elementCount: 0,
    document: { version: 1, elements: [] },
  }
  let deleted = false
  const fetcher = vi.fn(async () =>
    deleted ? Response.json({ error: 'project_deleted' }, { status: 410 }) : Response.json(remote),
  )
  vi.stubGlobal('fetch', fetcher)
  const project = await projectRepository.importCloud(remote)
  const session = new CloudProjectSession(project, new CanvasEditor(new CanvasDoc()))
  await session.load()
  deleted = true
  await session.refresh(true)
  expect(session.getSnapshot().status).toBe('deleted')
  deleted = false
  remote.revision = 3
  await session.refresh(true)
  expect(session.getSnapshot().status).toBe('saved')
  expect(
    (await projectRepository.list()).find((item) => item.id === project.id)?.cloud?.deleted,
  ).toBeFalsy()
  session.dispose()
})

const VIDEO_GENERATION = {
  model: 'doubao-seedance-2-0-mini-260615',
  duration: 8,
  aspectRatio: '9:16',
  resolution: '720p',
} as const

it('画布上有视频照常同步：封面上传，播放来源与生成参数写进云端结构', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const { project, editor } = await fresh()
  const mediaId = crypto.randomUUID()
  const poster = 'data:image/png;base64,UE9TVEVS'
  editor.doc.addElements(
    [
      {
        id: 'clip',
        type: 'image',
        fileId: 'poster',
        x: 10,
        y: 20,
        width: 180,
        height: 320,
        rotation: 0,
        video: { taskId: 'task-1', outputIndex: 0, generation: VIDEO_GENERATION },
      },
    ],
    { files: { poster } },
  )
  const saved: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === poster)
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      if (url.endsWith('/uploads')) return Response.json({ id: mediaId, status: 'ready' })
      const body = JSON.parse(init!.body as string)
      saved.push(body)
      return Response.json(receipt(project.id, body))
    }),
  )
  const session = new CloudProjectSession(project, editor)
  await session.load(true)

  expect(session.getSnapshot().status).toBe('saved')
  expect(saved[saved.length - 1]).toMatchObject({
    document: {
      elements: [
        { id: 'note' },
        {
          id: 'clip',
          type: 'image',
          mediaId,
          video: { taskId: 'task-1', outputIndex: 0, generation: VIDEO_GENERATION },
        },
      ],
    },
  })
  session.dispose()
})

it('新设备打开含视频的云端项目，视频的播放来源与生成参数都在', async () => {
  setClientStorageScope(crypto.randomUUID())
  const mediaId = crypto.randomUUID()
  const clip = {
    id: 'clip',
    type: 'image',
    mediaId,
    x: 0,
    y: 0,
    width: 180,
    height: 320,
    rotation: 0,
    video: { taskId: 'task-1', outputIndex: 0, generation: VIDEO_GENERATION },
  }
  const remote = {
    id: crypto.randomUUID(),
    name: '视频画布',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    elementCount: 1,
    document: { version: 1, elements: [clip] },
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(remote)),
  )
  const project = await projectRepository.importCloud(remote)
  const editor = new CanvasEditor(new CanvasDoc())
  const session = new CloudProjectSession(project, editor)
  await session.load()

  expect(session.getSnapshot().status).toBe('saved')
  const restored = editor.doc.elements[0]
  expect(restored).toMatchObject({
    id: 'clip',
    video: { taskId: 'task-1', outputIndex: 0, generation: VIDEO_GENERATION },
  })
  expect(restored?.type === 'image' && editor.doc.files[restored.fileId]).toBe(
    `aip-media:${mediaId}`,
  )
  session.dispose()
})

it('时间线随云端项目往返：引用、入出点都在，保存时不带媒体', async () => {
  setClientStorageScope(crypto.randomUUID())
  const mediaId = crypto.randomUUID()
  const clip = {
    id: 'clip',
    type: 'image',
    mediaId,
    x: 0,
    y: 0,
    width: 180,
    height: 320,
    rotation: 0,
    video: { taskId: 'task-1', outputIndex: 0, generation: VIDEO_GENERATION },
  }
  const timeline = {
    id: 'tl',
    type: 'timeline',
    x: 0,
    y: 400,
    width: 300,
    height: 120,
    clips: [
      { elementId: 'clip', in: 0.5, out: 6 },
      { elementId: 'gone', in: 0 },
    ],
  }
  const remote = {
    id: crypto.randomUUID(),
    name: '时间线画布',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    elementCount: 2,
    document: { version: 1, elements: [clip, timeline] },
  }
  const saved: { document: { elements: unknown[] } }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body as string)
        saved.push(body)
        return Response.json(receipt(remote.id, body))
      }
      return Response.json(remote)
    }),
  )
  const project = await projectRepository.importCloud(remote)
  const editor = new CanvasEditor(new CanvasDoc())
  const session = new CloudProjectSession(project, editor)
  await session.load()

  expect(session.getSnapshot().status).toBe('saved')
  expect(editor.doc.getElement('tl')).toMatchObject(timeline)
  editor.doc.updateElements([{ id: 'tl', patch: { x: 50 } }])
  await session.sync()
  expect(saved[saved.length - 1]?.document.elements[1]).toMatchObject({ ...timeline, x: 50 })
  expect(JSON.stringify(saved[saved.length - 1])).not.toContain('data:')
  session.dispose()
})
