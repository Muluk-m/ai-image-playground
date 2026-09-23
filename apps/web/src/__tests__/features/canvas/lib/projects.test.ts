// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { readPersistedScene } from '../../../../features/canvas/lib/persistence'
import {
  projectRepository,
  UNTITLED_PROJECT,
} from '../../../../features/canvas/lib/projectRepository'
import { setClientStorageScope } from '../../../../lib/authScope'
import { saveSceneRecord } from '../../../helpers/sceneRecord'

afterEach(() => setClientStorageScope(null))

describe('项目持久化', () => {
  it('两个未开始对话的项目独立保存，绑定会话后原画布可恢复', async () => {
    setClientStorageScope(crypto.randomUUID())
    const first = await projectRepository.create('产品海报')
    const second = await projectRepository.create('参考收集')
    await saveSceneRecord(first.sceneKey, 42)
    await projectRepository.update(first.id, { conversationId: 'conversation-a' })
    const projects = await projectRepository.list()
    expect(projects).toHaveLength(2)
    expect(projects.find((one) => one.id === first.id)?.conversationId).toBe('conversation-a')
    expect((await readPersistedScene(first.sceneKey))?.camera.x).toBe(42)
    expect(await readPersistedScene(second.sceneKey)).toBeUndefined()
  })

  it('重命名和删除只影响目标项目，删除后刷新不重新导入', async () => {
    setClientStorageScope(crypto.randomUUID())
    const first = await projectRepository.create('A')
    const second = await projectRepository.create('B')
    await projectRepository.update(first.id, { name: '新的名字', customName: true })
    await saveSceneRecord(first.sceneKey)
    await projectRepository.remove(first.id)
    expect((await projectRepository.list()).map((one) => one.id)).toEqual([second.id])
    expect(await readPersistedScene(first.sceneKey)).toBeUndefined()
  })

  it('账号之间不能看到对方的项目', async () => {
    setClientStorageScope(`a/${crypto.randomUUID()}`)
    await projectRepository.create('A 私有项目')
    setClientStorageScope(`b_${crypto.randomUUID()}`)
    expect(await projectRepository.list()).toEqual([])
  })
})

it('旧场景按原 key 导入，重复导入不会复制项目', async () => {
  setClientStorageScope(crypto.randomUUID())
  const { canvasSceneKey } = await import('../../../../features/canvas/lib/workspaces')
  const sceneKey = canvasSceneKey('legacy-conversation')
  await saveSceneRecord(sceneKey, 123)
  expect(await projectRepository.legacyScenes()).toEqual([
    { sceneKey, conversationId: 'legacy-conversation' },
  ])
  const legacy = { sceneKey, conversationId: 'legacy-conversation' }
  const [a, b] = await Promise.all([
    projectRepository.create('旧项目', legacy),
    projectRepository.create('旧项目', legacy),
  ])
  expect(a.id).toBe(b.id)
  expect(await projectRepository.list()).toHaveLength(1)
  expect((await readPersistedScene(a.sceneKey))?.camera.x).toBe(123)
})

it('云端会话关联在另一设备恢复，刷新关联不覆盖本机未同步的项目内容', async () => {
  setClientStorageScope(crypto.randomUUID())
  const id = crypto.randomUUID()
  const summary = {
    id,
    name: '云端项目',
    revision: 3,
    createdAt: 1,
    updatedAt: 2,
    elementCount: 0,
    coverMediaId: null,
    conversationId: crypto.randomUUID(),
  }
  const imported = await projectRepository.importCloud(summary)
  expect(imported.conversationId).toBe(summary.conversationId)
  await projectRepository.update(id, { name: '本机未同步名称' })
  const changed = { ...summary, conversationId: crypto.randomUUID(), revision: 4 }
  const refreshed = await projectRepository.importCloud(changed)
  expect(refreshed.conversationId).toBe(changed.conversationId)
  expect(refreshed.name).toBe('本机未同步名称')
  expect(refreshed.cloud?.revision).toBe(3)
  expect((await projectRepository.list())[0]?.conversationId).toBe(changed.conversationId)
})

it('云端那份还叫未命名时不算用户起的名字，会话标题还能接手', async () => {
  setClientStorageScope(crypto.randomUUID())
  const summary = {
    id: crypto.randomUUID(),
    name: UNTITLED_PROJECT,
    revision: 1,
    createdAt: 1,
    updatedAt: 2,
    elementCount: 0,
    coverMediaId: null,
    conversationId: crypto.randomUUID(),
  }
  expect((await projectRepository.importCloud(summary)).customName).toBe(false)
  const named = { ...summary, id: crypto.randomUUID(), name: '浴缸多视角' }
  expect((await projectRepository.importCloud(named)).customName).toBe(true)
})
