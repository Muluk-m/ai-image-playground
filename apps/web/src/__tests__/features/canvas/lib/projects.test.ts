// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { loadScene, saveScene } from '../../../../features/canvas/lib/persistence'
import { projectRepository } from '../../../../features/canvas/lib/projectRepository'
import { setClientStorageScope } from '../../../../lib/authScope'

afterEach(() => setClientStorageScope(null))

describe('项目持久化', () => {
  it('两个未开始对话的项目独立保存，绑定会话后原画布可恢复', async () => {
    setClientStorageScope(crypto.randomUUID())
    const first = await projectRepository.create('产品海报')
    const second = await projectRepository.create('参考收集')
    const editor = new CanvasEditor(new CanvasDoc())
    editor.doc.setCamera({ x: 42 })
    await saveScene(editor, first.sceneKey)
    await projectRepository.update(first.id, { conversationId: 'conversation-a' })
    const projects = await projectRepository.list()
    expect(projects).toHaveLength(2)
    expect(projects.find((one) => one.id === first.id)?.conversationId).toBe('conversation-a')
    const restored = new CanvasEditor(new CanvasDoc())
    await loadScene(restored, first.sceneKey)
    expect(restored.doc.camera.x).toBe(42)
    expect(await loadScene(new CanvasEditor(new CanvasDoc()), second.sceneKey)).toBe(false)
  })

  it('重命名和删除只影响目标项目，删除后刷新不重新导入', async () => {
    setClientStorageScope(crypto.randomUUID())
    const first = await projectRepository.create('A')
    const second = await projectRepository.create('B')
    await projectRepository.update(first.id, { name: '新的名字', customName: true })
    await saveScene(new CanvasEditor(new CanvasDoc()), first.sceneKey)
    await projectRepository.remove(first.id)
    expect((await projectRepository.list()).map((one) => one.id)).toEqual([second.id])
    expect(await loadScene(new CanvasEditor(new CanvasDoc()), first.sceneKey)).toBe(false)
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
  const editor = new CanvasEditor(new CanvasDoc())
  editor.doc.setCamera({ x: 123 })
  await saveScene(editor, sceneKey)
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
  const restored = new CanvasEditor(new CanvasDoc())
  await loadScene(restored, a.sceneKey)
  expect(restored.doc.camera.x).toBe(123)
})
