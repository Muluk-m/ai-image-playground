// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { useAgentStore } from '../../../features/agent/store'
import {
  currentCanvasWorkspace,
  selectCanvasWorkspace,
} from '../../../features/canvas/lib/workspaces'
import { useCanvasProjectStore } from '../../../features/canvas/projectStore'
import { setClientStorageScope } from '../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../lib/clientCapabilities'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const conversationId = '163f0e81-1295-4d5c-bf87-0dca82631420'
afterEach(async () => {
  currentCanvasWorkspace().dispose()
  await bootstrapClientCapabilities(false, '')
  setClientStorageScope(null)
  vi.unstubAllGlobals()
})

it('云端项目首次发送先保存项目并使用服务端绑定的会话，不创建独立会话', async () => {
  history.replaceState(null, '', '/')
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const calls: string[] = []
  let saved = false
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url}`)
    if (url.endsWith('/capabilities'))
      return Response.json({ 'accounts:sync': true, 'agent:chat': true })
    if (url.endsWith('/projects')) return Response.json({ projects: [], nextCursor: null })
    if (url.endsWith('/conversation')) {
      expect(saved).toBe(true)
      return Response.json({
        conversation: { id: conversationId, title: '', createdAt: 1, updatedAt: 1 },
      })
    }
    if (url.includes('/projects/')) {
      if (method === 'GET') return Response.json({ error: 'project_not_found' }, { status: 404 })
      const body = JSON.parse(init!.body as string)
      saved = true
      return Response.json({
        id: url.split('/').pop(),
        ...body,
        revision: body.baseRevision + 1,
        createdAt: 1,
        updatedAt: 1,
        elementCount: 0,
      })
    }
    if (url.endsWith('/messages'))
      return Response.json({
        messages: [
          {
            id: 'existing-message',
            turnId: 'existing-turn',
            role: 'assistant',
            content: [{ type: 'text', text: '其他设备已有的回答' }],
          },
        ],
        turns: [],
        activeTurn: null,
      })
    if (url.endsWith('/turns')) return Response.json({ error: 'test_unavailable' }, { status: 503 })
    if (url.endsWith('/conversations') && method === 'POST')
      return Response.json({
        conversation: { id: 'wrong-standalone', title: '', createdAt: 1, updatedAt: 1 },
      })
    return Response.json({ messages: [], turns: [], activeTurn: null })
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useCanvasProjectStore.setState({
    projects: [],
    activeId: null,
    loaded: false,
    error: null,
    cloudLoading: false,
    cloudCatalog: {},
  })
  await useCanvasProjectStore.getState().load()
  selectCanvasWorkspace(null)
  await currentCanvasWorkspace().ready
  useAgentStore.setState({
    loaded: true,
    conversationId: null,
    messages: [],
    turns: {},
    turn: 'idle',
    stopping: false,
    activeTurn: null,
    error: null,
    historyFailed: false,
    historyLoading: false,
  })
  await useAgentStore.getState().send('为项目生成图片')
  expect(useAgentStore.getState().conversationId).toBe(conversationId)
  expect(useAgentStore.getState().messages).toEqual(
    expect.arrayContaining([expect.objectContaining({ text: '其他设备已有的回答' })]),
  )
  expect(calls.some((call) => call === 'POST http://bff.test/api/agent/conversations')).toBe(false)
  expect(calls.filter((call) => call.endsWith('/turns'))).toEqual([
    `POST http://bff.test/api/agent/conversations/${conversationId}/turns`,
  ])
})

it('重新打开项目读取另一设备绑定的会话，历史加载失败重试不发送生成请求', async () => {
  history.replaceState(null, '', '/')
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const project = {
    id: crypto.randomUUID(),
    name: '另一设备项目',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    elementCount: 0,
    conversationId: null,
  }
  const requests: string[] = []
  let failHistory = true
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    requests.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.endsWith('/capabilities'))
      return Response.json({ 'accounts:sync': true, 'agent:chat': true })
    if (url.endsWith('/projects')) return Response.json({ projects: [project], nextCursor: null })
    if (url.includes('/projects/'))
      return Response.json({ ...project, conversationId, document: { version: 1, elements: [] } })
    if (url.endsWith('/messages')) {
      if (failHistory) return Response.json({ error: 'unavailable' }, { status: 503 })
      return Response.json({
        messages: [
          {
            id: 'message',
            turnId: 'turn',
            role: 'assistant',
            content: [{ type: 'text', text: '另一设备的回答' }],
          },
        ],
        turns: [],
        activeTurn: null,
      })
    }
    return Response.json({ conversations: [] })
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useCanvasProjectStore.setState({
    projects: [],
    activeId: null,
    loaded: false,
    error: null,
    cloudLoading: false,
    cloudCatalog: {},
  })
  await useCanvasProjectStore.getState().load()
  selectCanvasWorkspace(null)
  await currentCanvasWorkspace().ready
  useAgentStore.setState({
    loaded: true,
    conversationId: null,
    messages: [],
    turns: {},
    turn: 'idle',
    stopping: false,
    activeTurn: null,
    error: null,
    historyFailed: false,
    historyLoading: false,
  })
  expect(await useAgentStore.getState().selectProject(project.id)).toBe(true)
  await vi.waitFor(() => expect(useAgentStore.getState().historyFailed).toBe(true))
  expect(useAgentStore.getState().conversationId).toBe(conversationId)
  failHistory = false
  await useAgentStore.getState().retryHistory()
  expect(useAgentStore.getState().messages).toMatchObject([{ text: '另一设备的回答' }])
  expect(useAgentStore.getState().historyFailed).toBe(false)
  expect(requests.every((request) => request.startsWith('GET '))).toBe(true)
})

it.each([
  200, 409,
])('升级认领已有会话，返回 %s 时保留关联或显示冲突，不另建上下文', async (status) => {
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const { projectRepository } = await import('../../../features/canvas/lib/projectRepository')
  const project = await projectRepository.create('升级前项目', undefined, true)
  await projectRepository.update(project.id, { conversationId, cloud: { revision: 1 } })
  const local = (await projectRepository.list())[0]
  const bodies: unknown[] = []
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/capabilities'))
      return Response.json({ 'accounts:sync': true, 'agent:chat': true })
    if (url.endsWith('/conversation')) {
      bodies.push(JSON.parse(init!.body as string))
      if (status === 409)
        return Response.json({ error: 'project_conversation_conflict' }, { status })
      return Response.json({
        conversation: { id: conversationId, title: '', createdAt: 1, updatedAt: 1 },
      })
    }
    return Response.json({
      projects: [
        {
          id: project.id,
          name: project.name,
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
          elementCount: 0,
          conversationId: null,
        },
      ],
      nextCursor: null,
    })
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useCanvasProjectStore.setState({
    projects: [local],
    activeId: project.id,
    loaded: true,
    cloudLoading: false,
    cloudCatalog: {},
  })
  await useCanvasProjectStore.getState().refreshCloud()
  expect(useCanvasProjectStore.getState().projects[0].conversationId).toBe(conversationId)
  expect(bodies).toEqual([{ conversationId }])
  expect(Boolean(useCanvasProjectStore.getState().cloudError)).toBe(status === 409)
})

it('目录接收删除墓碑后隐藏云端项目，仍保留本机内容，恢复后重新显示', async () => {
  const { projectRepository } = await import('../../../features/canvas/lib/projectRepository')
  const { projectCatalog } = await import('../../../features/canvas/lib/projectCatalog')
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const summary = {
    id: crypto.randomUUID(),
    name: '保留本机编辑',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    elementCount: 0,
  }
  const local = await projectRepository.importCloud(summary)
  let deleted = true
  vi.stubGlobal('fetch', async (input: unknown) =>
    String(input).endsWith('/capabilities')
      ? Response.json({ 'accounts:sync': true })
      : Response.json({
          projects: deleted ? [] : [summary],
          deletedIds: deleted ? [summary.id] : [],
          nextCursor: null,
        }),
  )
  await bootstrapClientCapabilities(true, 'http://bff.test')
  useCanvasProjectStore.setState({
    projects: [local],
    loaded: true,
    cloudLoading: false,
    cloudCatalog: { [summary.id]: summary },
  })
  await useCanvasProjectStore.getState().refreshCloud()
  let state = useCanvasProjectStore.getState()
  expect(projectCatalog(state.projects, state.cloudCatalog)).toHaveLength(0)
  expect((await projectRepository.list()).find((one) => one.id === summary.id)).toMatchObject({
    cloud: { deleted: true },
  })
  deleted = false
  await useCanvasProjectStore.getState().refreshCloud()
  state = useCanvasProjectStore.getState()
  expect(projectCatalog(state.projects, state.cloudCatalog)).toMatchObject([{ id: summary.id }])
})
