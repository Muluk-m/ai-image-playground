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
import { loadScene } from '../../../../features/canvas/lib/persistence'
import { projectRepository } from '../../../../features/canvas/lib/projectRepository'
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
  const session = new CloudProjectSession(project, editor, undefined, (copy) => {
    forked.push(copy.id)
  })
  await session.load(true)
  // 不需要用户点任何东西：本机稿已经落成独立项目，正本换上云端稿，人留在正本。
  await vi.waitFor(() => expect(forked).toHaveLength(1))
  await vi.waitFor(() => expect(session.getSnapshot().status).toBe('saved'))
  const copies = await projectRepository.list()
  expect(copies).toHaveLength(2)
  const copied = new CanvasEditor(new CanvasDoc())
  await loadScene(copied, copies.find((one) => one.id === forked[0])!.sceneKey)
  expect(copied.doc.elements[0]).toMatchObject({ text: '本机原稿' })
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
