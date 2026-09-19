// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import ProjectTrash from '../../features/canvas/components/ProjectTrash'
import { useCanvasProjectStore } from '../../features/canvas/projectStore'
import { setClientStorageScope } from '../../lib/authScope'
import { bootstrapClientCapabilities } from '../../lib/clientCapabilities'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'

it('回收站展示到期日并从实际恢复入口恢复项目身份', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const project = {
    id: crypto.randomUUID(),
    name: '回收中的海报',
    revision: 2,
    createdAt: 1,
    updatedAt: 2,
    elementCount: 0,
    deletedAt: 2,
    restoreUntil: Date.now() + 86400000,
  }
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.endsWith('/capabilities')) return Response.json({ 'accounts:sync': true })
    if (url.endsWith('/restore')) return Response.json({ ok: true })
    if (url.endsWith(`/projects/${project.id}`))
      return Response.json({ ...project, revision: 3, document: { version: 1, elements: [] } })
    if (url.endsWith('/trash')) return Response.json({ projects: [project], nextCursor: null })
    return Response.json({
      projects: [{ ...project, revision: 3 }],
      nextCursor: null,
      deletedIds: [],
    })
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useCanvasProjectStore.setState({
    projects: [],
    loaded: true,
    cloudLoading: false,
    cloudCatalog: {},
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(<ProjectTrash onBack={() => {}} onOpen={async () => {}} />)
    })
    await vi.waitFor(() => expect(host.textContent).toContain(project.name))
    expect(host.textContent).toContain('可恢复至')
    const restore = [...host.querySelectorAll('button')].find((one) => one.textContent === '恢复')!
    await act(async () => {
      restore.click()
    })
    await vi.waitFor(() => expect(host.textContent).toContain('回收站为空'))
    expect(calls).toContain(`POST http://bff.test/api/projects/${project.id}/restore`)
    expect(useCanvasProjectStore.getState().projects).toMatchObject([{ id: project.id }])
  } finally {
    await act(async () => root.unmount())
    host.remove()
    await bootstrapClientCapabilities(false, '')
    setClientStorageScope(null)
    vi.unstubAllGlobals()
  }
})

it('实际项目列表回收站把过期项目的本机编辑存为新身份，原接口410不会拦住打开', async () => {
  const { webcrypto } = await import('node:crypto')
  const { default: ProjectGrid } = await import('../../features/canvas/components/ProjectGrid')
  const { projectRepository } = await import('../../features/canvas/lib/projectRepository')
  const { CanvasDoc } = await import('../../features/canvas/lib/canvasDoc')
  const { CanvasEditor } = await import('../../features/canvas/lib/editor')
  const { saveScene } = await import('../../features/canvas/lib/persistence')
  const { currentCanvasWorkspace, selectCanvasWorkspace } = await import(
    '../../features/canvas/lib/workspaces'
  )
  const { useAgentStore } = await import('../../features/agent/store')
  vi.stubGlobal('crypto', webcrypto)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  history.replaceState(null, '', '/')
  const id = crypto.randomUUID()
  const local = await projectRepository.importCloud({
    id,
    name: '过期原项目',
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    elementCount: 1,
  })
  const deleted = await projectRepository.update(id, { cloud: { revision: 1, deleted: true } })
  const editor = new CanvasEditor(new CanvasDoc())
  editor.doc.addElements([
    {
      id: 'local-edit',
      type: 'text',
      x: 5,
      y: 8,
      width: 180,
      height: 50,
      text: '断网时的编辑',
      fontSize: 24,
      fill: '#000000',
    },
  ])
  await saveScene(editor, local.sceneKey)
  const writes: string[] = []
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/capabilities')) return Response.json({ 'accounts:sync': true })
    if (url.endsWith('/trash') || url.endsWith('/projects'))
      return Response.json({ projects: [], deletedIds: [id], nextCursor: null })
    if (url.endsWith(`/projects/${id}`))
      return Response.json({ error: 'project_deleted' }, { status: 410 })
    if (init?.method === 'PUT' && url.includes('/projects/')) {
      writes.push(url)
      const body = JSON.parse(init.body as string)
      return Response.json({
        id: url.split('/').pop(),
        name: body.name,
        revision: body.baseRevision + 1,
        createdAt: 1,
        updatedAt: 3,
        elementCount: body.document.elements.length,
      })
    }
    return Response.json({ conversations: [], messages: [], turns: [], activeTurn: null })
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useCanvasProjectStore.setState({
    projects: [deleted],
    activeId: id,
    loaded: true,
    cloudLoading: false,
    cloudCatalog: {},
  })
  useAgentStore.setState({
    loaded: true,
    conversationId: null,
    messages: [],
    turns: {},
    turn: 'idle',
    stopping: false,
    activeTurn: null,
    historyLoading: false,
    historyFailed: false,
  })
  selectCanvasWorkspace(null)
  await currentCanvasWorkspace().ready
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ProjectGrid />))
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((one) => one.textContent?.includes('回收站'))!
        .click(),
    )
    await vi.waitFor(() => expect(host.textContent).toContain('当前编辑另存为新项目'))
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((one) => one.textContent === '当前编辑另存为新项目')!
        .click(),
    )
    await vi.waitFor(() => expect(useCanvasProjectStore.getState().activeId).not.toBe(id))
    await currentCanvasWorkspace().ready
    expect(currentCanvasWorkspace().doc.elements).toMatchObject([
      { id: 'local-edit', text: '断网时的编辑' },
    ])
    expect(useAgentStore.getState().conversationId).toBeNull()
    expect(writes.some((url) => url.endsWith(`/${id}`))).toBe(false)
  } finally {
    await act(async () => root.unmount())
    currentCanvasWorkspace().dispose()
    host.remove()
    await bootstrapClientCapabilities(false, '')
    setClientStorageScope(null)
    vi.unstubAllGlobals()
  }
})
