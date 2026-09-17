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
import { setClientStorageScope } from '../../../../lib/authScope'

it('冲突界面提供保留两稿的恢复动作，采用云端稿后副本仍在项目目录', async () => {
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
  const session = new CloudProjectSession(project, editor)
  await session.load(true)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ProjectSyncStatus session={session} />))
    const buttons = Array.from(host.querySelectorAll('button'))
    expect(buttons.map((button) => button.textContent)).toEqual(['使用云端版', '本机版另存为项目'])
    await act(async () => buttons[0]!.click())
    await vi.waitFor(() => expect(host.textContent).toContain('画布已同步'))
    expect(await projectRepository.list()).toHaveLength(2)
    expect(editor.doc.elements).toEqual([])
  } finally {
    act(() => root.unmount())
    host.remove()
    session.dispose()
    setClientStorageScope(null)
    vi.unstubAllGlobals()
  }
})
