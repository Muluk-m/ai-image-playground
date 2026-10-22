// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import ProjectSyncStatus, {
  PENDING_VISIBLE_AFTER_MS,
} from '../../../../features/canvas/components/ProjectSyncStatus'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CloudProjectSession } from '../../../../features/canvas/lib/cloudProjects'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { projectRepository } from '../../../../features/canvas/lib/projectRepository'
import { SceneRecord } from '../../../../features/canvas/lib/sceneRecord'
import { setClientStorageScope } from '../../../../lib/authScope'

it('冲突自动把当前修改另存为副本并换上云端稿，手动按钮仍是兜底', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope(crypto.randomUUID())
  const project = await projectRepository.create('冲突项目', undefined, true)
  const editor = new CanvasEditor(new CanvasDoc())
  editor.doc.addElements([
    {
      id: 'text',
      type: 'text',
      x: 0,
      y: 0,
      width: 80,
      height: 40,
      text: '本机原稿',
      fontSize: 24,
      fill: '#000',
    },
  ])
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Response.json({ error: 'project_conflict' }, { status: 409 })
        : Response.json({
            id: project.id,
            name: '云端稿',
            revision: 2,
            createdAt: 1,
            updatedAt: 2,
            elementCount: 0,
            document: { version: 1, elements: [] },
          }),
    ),
  )
  const forked: string[] = []
  const record = new SceneRecord(editor, project.sceneKey)
  await record.open()
  const session = new CloudProjectSession(project, record, undefined, (copy) => {
    forked.push(copy.id)
  })
  await session.load(true)
  // 不需要用户点任何东西：本机稿已经落成独立项目，正本换上云端稿，人留在正本。
  await vi.waitFor(() => expect(forked).toHaveLength(1))
  await vi.waitFor(() => expect(session.getSnapshot().status).toBe('saved'))
  const copies = await projectRepository.list()
  expect(copies).toHaveLength(2)
  const copied = new SceneRecord(
    new CanvasEditor(new CanvasDoc()),
    copies.find((one) => one.id === forked[0])!.sceneKey,
  )
  await copied.open()
  expect(copied.editor.doc.elements[0]).toMatchObject({ text: '本机原稿' })
  expect(editor.doc.elements).toEqual([])
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ProjectSyncStatus session={session} />))
    await vi.waitFor(() => expect(host.textContent).toContain('已保存'))
    // 冲突已经自动解完，没有按钮可按；也不会堆出第三个项目。
    expect(host.querySelectorAll('button')).toHaveLength(0)
    expect(await projectRepository.list()).toHaveLength(2)
  } finally {
    act(() => root.unmount())
    host.remove()
    session.dispose()
    setClientStorageScope(null)
    vi.unstubAllGlobals()
  }
})

it('读取失败时画布已经在用：给重试，重新读一遍而不是推送', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const reload = vi.fn(async () => {})
  const sync = vi.fn(async () => {})
  const snapshot = { status: 'load-error' as const, message: null }
  const session = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    reload,
    sync,
  } as unknown as CloudProjectSession
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<ProjectSyncStatus session={session} />))

  const retry = [...host.querySelectorAll('button')].find((one) => one.textContent === '重试')
  expect(retry).toBeDefined()
  act(() => retry!.click())
  expect(reload).toHaveBeenCalledOnce()
  expect(sync).not.toHaveBeenCalled()
  act(() => root.unmount())
})

it('安静模式下媒体未保存时仍可重试同步，成功后隐藏提示', async () => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setClientStorageScope(crypto.randomUUID())
  const project = await projectRepository.create('媒体重试项目', undefined, true)
  const record = new SceneRecord(new CanvasEditor(new CanvasDoc()), project.sceneKey)
  await record.open()
  const session = new CloudProjectSession(project, record)
  let snapshot: ReturnType<CloudProjectSession['getSnapshot']> = {
    status: 'media-local',
    message: null,
  }
  vi.spyOn(session, 'getSnapshot').mockImplementation(() => snapshot)
  const subscribe = vi.spyOn(session, 'subscribe')
  const sync = vi.spyOn(session, 'sync').mockResolvedValue(undefined)
  const reload = vi.spyOn(session, 'reload').mockResolvedValue(undefined)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ProjectSyncStatus session={session} quiet />))
    expect(host.querySelector('[role="status"]')?.textContent).toContain('画布里有内容还没保存完')
    expect(host.querySelectorAll('button')).toHaveLength(1)
    const retry = host.querySelector('button')
    expect(retry?.textContent).toBe('重试')
    expect(retry?.disabled).toBe(false)
    await act(async () => retry?.click())
    expect(sync).toHaveBeenCalledOnce()
    expect(reload).not.toHaveBeenCalled()

    for (const status of ['syncing', 'saved'] as const) {
      act(() => {
        snapshot = { status, message: null }
        subscribe.mock.calls[0]?.[0]()
      })
      expect(host.childElementCount).toBe(0)
    }
  } finally {
    act(() => root.unmount())
    host.remove()
    session.dispose()
    record.dispose()
    setClientStorageScope(null)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})

it('安静模式下短暂的等待保存不露面，持续卡住才提示并给重试', () => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let snapshot: { status: 'pending' | 'syncing' | 'saved' | 'offline'; message: null } = {
    status: 'pending',
    message: null,
  }
  const listeners = new Set<() => void>()
  const sync = vi.fn(async () => {})
  const session = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    reload: vi.fn(async () => {}),
    sync,
  } as unknown as CloudProjectSession
  const set = (status: typeof snapshot.status) =>
    act(() => {
      snapshot = { status, message: null }
      for (const listener of listeners) listener()
    })
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() => root.render(<ProjectSyncStatus session={session} quiet />))
    // 跑节点时 pending 与 syncing 来回跳：每一段都很短，一直不露面。
    for (let i = 0; i < 5; i++) {
      act(() => vi.advanceTimersByTime(PENDING_VISIBLE_AFTER_MS - 1000))
      expect(host.childElementCount).toBe(0)
      set('syncing')
      expect(host.childElementCount).toBe(0)
      set('pending')
      expect(host.childElementCount).toBe(0)
    }
    set('saved')
    expect(host.childElementCount).toBe(0)
    // 连续卡在 pending 超过阈值：提示等待保存，并给重试。
    set('pending')
    act(() => vi.advanceTimersByTime(PENDING_VISIBLE_AFTER_MS))
    expect(host.textContent).toContain('等待保存')
    const retry = host.querySelector('button')
    expect(retry?.textContent).toBe('重试')
    act(() => retry?.click())
    expect(sync).toHaveBeenCalledOnce()
    // 存上了立即收起；再进 pending 重新计时。
    set('saved')
    expect(host.childElementCount).toBe(0)
    set('pending')
    expect(host.childElementCount).toBe(0)
    // 真正的故障不等阈值，立刻显示。
    set('offline')
    expect(host.textContent).toContain('改动已保留，等待联网')
  } finally {
    act(() => root.unmount())
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it('非安静模式照常立即显示等待保存', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const snapshot = { status: 'pending' as const, message: null }
  const session = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    reload: vi.fn(async () => {}),
    sync: vi.fn(async () => {}),
  } as unknown as CloudProjectSession
  const host = document.createElement('div')
  const root = createRoot(host)
  act(() => root.render(<ProjectSyncStatus session={session} />))
  expect(host.textContent).toContain('等待保存')
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

it('图片在后台上传时只显示上传进度，不亮等待保存与重试', () => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  type Snapshot = ReturnType<CloudProjectSession['getSnapshot']>
  let snapshot: Snapshot = { status: 'pending', message: null, upload: { done: 1, total: 4 } }
  const listeners = new Set<() => void>()
  const session = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    reload: vi.fn(async () => {}),
    sync: vi.fn(async () => {}),
  } as unknown as CloudProjectSession
  const set = (next: Snapshot) =>
    act(() => {
      snapshot = next
      for (const listener of listeners) listener()
    })
  for (const quiet of [true, false]) {
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      set({ status: 'pending', message: null, upload: { done: 1, total: 4 } })
      act(() => root.render(<ProjectSyncStatus session={session} quiet={quiet} />))
      act(() => vi.advanceTimersByTime(PENDING_VISIBLE_AFTER_MS * 2))
      expect(host.textContent).toBe('图片上传中 1/4')
      expect(host.querySelectorAll('button')).toHaveLength(0)
      // 文档已经确认、图片还在传：照样只有进度。
      set({ status: 'syncing', message: null, upload: { done: 3, total: 4 } })
      expect(host.textContent).toContain('图片上传中 3/4')
      expect(host.textContent).not.toContain('等待保存')
      set({ status: 'saved', message: null })
      expect(host.textContent).not.toContain('图片上传中')
      if (quiet) expect(host.childElementCount).toBe(0)
      // 上传失败后进 media-local：恢复原来的提示和重试。
      set({ status: 'media-local', message: null })
      expect(host.textContent).toContain('画布里有内容还没保存完')
      expect(host.querySelector('button')?.textContent).toBe('重试')
      // 上传还在跑时出了别的错（无权限、冲突、项目被删）：错误和操作照常露出，上传进度并列显示。
      set({ status: 'permission-error', message: null, upload: { done: 2, total: 4 } })
      expect(host.textContent).toContain('图片上传中 2/4')
      expect(host.querySelector('[role="alert"]')).not.toBeNull()
      expect(host.querySelector('button')?.textContent).toBe('重试')
      set({ status: 'conflict', message: null, upload: { done: 2, total: 4 } })
      expect(host.textContent).toContain('图片上传中 2/4')
      expect(host.querySelectorAll('button').length).toBeGreaterThan(0)
    } finally {
      act(() => root.unmount())
    }
  }
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
