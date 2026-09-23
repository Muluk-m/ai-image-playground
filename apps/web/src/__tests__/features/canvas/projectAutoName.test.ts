// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import {
  currentCanvasWorkspace,
  forgetCanvasWorkspace,
  importConversationProjects,
} from '../../../features/canvas/lib/activeProject'
import { projectRepository, UNTITLED_PROJECT } from '../../../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../../../features/canvas/projectStore'
import { setClientStorageScope } from '../../../lib/authScope'
import { bootstrapClientCapabilities } from '../../../lib/clientCapabilities'
import { _setRuntimeConfigForTesting } from '../../../lib/runtimeConfig'

const cloud = { revision: 1, createdAt: 1, updatedAt: 1, elementCount: 0 }

afterEach(async () => {
  await bootstrapClientCapabilities(false, '')
  setClientStorageScope(null)
  vi.unstubAllGlobals()
})

it('本机与云端项目都按会话标题自动命名，改过名的不动，一个项目失败不挡后面的', async () => {
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const calls: string[] = []
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (url.endsWith('/capabilities')) return Response.json({ 'accounts:sync': true })
    return Response.json({ error: 'not_stubbed' }, { status: 500 })
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')

  const untitledId = crypto.randomUUID()
  const renamedId = crypto.randomUUID()
  const untitled = await projectRepository.importCloud({
    ...cloud,
    id: untitledId,
    name: UNTITLED_PROJECT,
    conversationId: 'conversation-untitled',
  })
  const renamed = await projectRepository.importCloud({
    ...cloud,
    id: renamedId,
    name: '我自己起的名字',
    conversationId: 'conversation-renamed',
  })
  const local = await projectRepository.create(UNTITLED_PROJECT, {
    sceneKey: 'scene-local',
    conversationId: 'conversation-local',
  })
  useCanvasProjectStore.setState({
    // 第一条在本机目录里没有记录：改名一定失败，用来确认循环不会就此中断。
    projects: [
      { ...untitled, id: crypto.randomUUID(), conversationId: 'conversation-gone' },
      untitled,
      renamed,
      local,
    ],
    activeId: null,
    loaded: true,
    error: null,
    cloudLoading: false,
    cloudCatalog: {},
  })

  await importConversationProjects([
    { id: 'conversation-gone', title: '改不动的项目', createdAt: 1, updatedAt: 1 },
    { id: 'conversation-untitled', title: '水彩猫咪', createdAt: 1, updatedAt: 1 },
    { id: 'conversation-renamed', title: '服务端给的名字', createdAt: 1, updatedAt: 1 },
    { id: 'conversation-local', title: '本机的名字', createdAt: 1, updatedAt: 1 },
  ])

  const listed = useCanvasProjectStore.getState().projects
  expect(listed.find((one) => one.id === untitledId)?.name).toBe('水彩猫咪')
  expect(listed.find((one) => one.id === local.id)?.name).toBe('本机的名字')
  expect(listed.find((one) => one.id === renamedId)?.name).toBe('我自己起的名字')
  const stored = await projectRepository.list()
  expect(stored.find((one) => one.id === untitledId)).toMatchObject({
    name: '水彩猫咪',
    cloud: { nameDirty: true },
  })
  // 改个名字不该把整份文档拉下来；项目没打开就等下次打开时一起推上去。
  expect(calls.filter((call) => call.includes('/api/projects/'))).toEqual([])
})

it('打开着的云端项目自动命名后把新名字推上服务端', async () => {
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  const id = crypto.randomUUID()
  const remote = {
    ...cloud,
    id,
    revision: 2,
    name: UNTITLED_PROJECT,
    conversationId: 'conversation-open',
    document: { version: 1, elements: [] },
  }
  const written: string[] = []
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/capabilities')) return Response.json({ 'accounts:sync': true })
    if (init?.method !== 'PUT') return Response.json(remote)
    const body = JSON.parse(init.body as string) as { name: string; baseRevision: number }
    written.push(body.name)
    return Response.json({ ...remote, name: body.name, revision: body.baseRevision + 1 })
  })
  await bootstrapClientCapabilities(true, 'http://bff.test')

  const project = await projectRepository.importCloud(remote)
  useCanvasProjectStore.setState({
    projects: [project],
    activeId: project.id,
    loaded: true,
    error: null,
    cloudLoading: false,
    cloudCatalog: {},
  })
  await currentCanvasWorkspace().ready

  await importConversationProjects([
    { id: 'conversation-open', title: '水彩猫咪', createdAt: 1, updatedAt: 1 },
  ])

  expect(written).toEqual(['水彩猫咪'])
  expect((await projectRepository.list()).find((one) => one.id === id)).toMatchObject({
    name: '水彩猫咪',
    customName: false,
    cloud: { revision: 3, nameDirty: false },
  })
  forgetCanvasWorkspace(project.sceneKey)
})
