// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import ProjectSyncStatus from '../../../../features/canvas/components/ProjectSyncStatus'
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
