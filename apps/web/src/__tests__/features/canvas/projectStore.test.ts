// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { projectRepository, UNTITLED_PROJECT } from '../../../features/canvas/lib/projectRepository'
import { useCanvasProjectStore } from '../../../features/canvas/projectStore'
import { setClientStorageScope } from '../../../lib/authScope'

// 云端关掉：这一组只看目录侧的改名决定，不牵动工作区与上传。
vi.mock('../../../features/canvas/lib/projectClient', () => ({
  cloudProjectsEnabled: () => false,
  listCloudProjects: vi.fn(),
  getCloudProject: vi.fn(),
  restoreDeletedCloudProject: vi.fn(),
  ensureCloudProjectConversation: vi.fn(),
  ProjectRequestError: class extends Error {},
}))

afterEach(() => {
  setClientStorageScope(null)
  useCanvasProjectStore.setState({ projects: [], activeId: null, loaded: false })
})

function conversation(id: string, title: string) {
  return { id, title, createdAt: 1, updatedAt: 2 }
}

it('会话有了标题就给还叫未命名的项目改名，云端来的那份也算数', async () => {
  setClientStorageScope(crypto.randomUUID())
  const auto = await projectRepository.create(UNTITLED_PROJECT, {
    sceneKey: 'scene-auto',
    conversationId: 'conversation-auto',
  })
  // 云端目录里同步下来的项目：名字还是未命名，所以自动命名仍然管得着。
  const cloud = await projectRepository.importCloud({
    id: crypto.randomUUID(),
    name: UNTITLED_PROJECT,
    revision: 2,
    createdAt: 1,
    updatedAt: 2,
    elementCount: 0,
    coverMediaId: null,
    conversationId: 'conversation-cloud',
  })
  const mine = await projectRepository.create('我自己起的名字', {
    sceneKey: 'scene-mine',
    conversationId: 'conversation-mine',
  })

  await useCanvasProjectStore
    .getState()
    .importConversations([
      conversation('conversation-auto', '浴缸多视角'),
      conversation('conversation-cloud', '客厅灯光'),
      conversation('conversation-mine', '别改我'),
    ])

  const named = (id: string) =>
    useCanvasProjectStore.getState().projects.find((one) => one.id === id)
  expect(named(auto.id)?.name).toBe('浴缸多视角')
  expect(named(cloud.id)?.name).toBe('客厅灯光')
  // 云端项目的自动名还没推上去，目录得先信本机这一份。
  expect(named(cloud.id)?.cloud?.nameDirty).toBe(true)
  expect(named(mine.id)?.name).toBe('我自己起的名字')
})
