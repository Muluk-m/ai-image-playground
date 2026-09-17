// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DraftSession } from '../../../../features/agent/lib/drafts'
import {
  currentProjectDraft,
  saveCurrentProject,
} from '../../../../features/agent/lib/projectLifecycle'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { loadScene } from '../../../../features/canvas/lib/persistence'
import {
  canvasSceneKey,
  currentCanvasWorkspace,
  selectCanvasWorkspace,
} from '../../../../features/canvas/lib/workspaces'
import {
  currentCanvasProject,
  useCanvasProjectStore,
} from '../../../../features/canvas/projectStore'
import { scopedStorageName, setClientStorageScope } from '../../../../lib/authScope'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

const fetchMock = vi.fn(async () => Response.json({ conversations: [] }))

/** 草稿键的期望值来自 drafts.ts 的存储格式，不复述被测函数的算式。 */
const projectDraftKey = (projectId: string) => scopedStorageName(`agent-project-draft:${projectId}`)
const legacyDraftKey = (conversationId: string | null) =>
  scopedStorageName(`agent-draft:${conversationId ?? 'new'}`)

async function restoredDraft(key: string): Promise<DraftSession> {
  const session = new DraftSession(key)
  await vi.waitFor(() => expect(session.getSnapshot().loading).toBe(false))
  return session
}

async function persistedCamera(sceneKey: string): Promise<number> {
  const editor = new CanvasEditor(new CanvasDoc())
  await loadScene(editor, sceneKey)
  return editor.doc.camera.x
}

/** 下一次 IndexedDB 写入中止，模拟落盘失败。 */
function abortNextPut() {
  const put = IDBObjectStore.prototype.put
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['put']>
  ) {
    const result = put.apply(this, args)
    this.transaction.abort()
    return result
  })
}

beforeEach(async () => {
  history.replaceState(null, '', '/')
  setClientStorageScope(crypto.randomUUID())
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  vi.stubGlobal('fetch', fetchMock)
  useCanvasProjectStore.setState({ projects: [], activeId: null, loaded: false, error: null })
  await useCanvasProjectStore.getState().load()
  selectCanvasWorkspace(null)
  await currentCanvasWorkspace().ready
})

afterEach(async () => {
  await currentCanvasWorkspace().flush()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  fetchMock.mockClear()
  setClientStorageScope(null)
})

it('草稿与画布都有未保存改动时，保存后两者都已落盘', async () => {
  const project = currentCanvasProject()!
  const draft = currentProjectDraft(null)
  await draft.ready
  draft.update({ prompt: '产品海报草稿', references: [] })
  currentCanvasWorkspace().doc.setCamera({ x: 42 })

  expect(await saveCurrentProject(null)).toEqual({ ok: true })

  expect((await restoredDraft(projectDraftKey(project.id))).getSnapshot().draft.prompt).toBe(
    '产品海报草稿',
  )
  expect(await persistedCamera(project.sceneKey)).toBe(42)
})

it('草稿落盘失败时保存失败，画布不会被写入', async () => {
  const project = currentCanvasProject()!
  const draft = currentProjectDraft(null)
  await draft.ready
  currentCanvasWorkspace().doc.setCamera({ x: 7 })
  expect(await saveCurrentProject(null)).toEqual({ ok: true })

  draft.update({ prompt: '还没保存的输入', references: [] })
  currentCanvasWorkspace().doc.setCamera({ x: 88 })
  abortNextPut()
  expect(await saveCurrentProject(null)).toEqual({ ok: false, reason: 'draft_save_failed' })
  expect(await persistedCamera(project.sceneKey)).toBe(7)
})

it('画布落盘失败时保存失败', async () => {
  const draft = currentProjectDraft(null)
  await draft.ready
  currentCanvasWorkspace().doc.setCamera({ x: 13 })
  abortNextPut()
  expect(await saveCurrentProject(null)).toEqual({ ok: false, reason: 'save_failed' })
})

it('没有当前项目也没有会话时，草稿落回会话键，画布照样保存', async () => {
  const sceneKey = currentCanvasProject()!.sceneKey
  useCanvasProjectStore.setState({ activeId: null })
  const draft = currentProjectDraft(null)
  await draft.ready
  expect(draft.key).toBe(legacyDraftKey(null))
  draft.update({ prompt: '没有项目时的输入', references: [] })
  currentCanvasWorkspace().doc.setCamera({ x: 5 })

  expect(await saveCurrentProject(null)).toEqual({ ok: true })

  expect((await restoredDraft(legacyDraftKey(null))).getSnapshot().draft.prompt).toBe(
    '没有项目时的输入',
  )
  expect(await persistedCamera(sceneKey)).toBe(5)
})

it('首次发送前的新项目沿用未绑定会话留下的草稿', async () => {
  const project = currentCanvasProject()!
  expect(project.sceneKey).toBe(canvasSceneKey(null))
  const legacy = new DraftSession(legacyDraftKey(null))
  await legacy.ready
  legacy.update({ prompt: '项目化之前写的', references: [] })
  await legacy.flush()

  const draft = currentProjectDraft(null)
  await vi.waitFor(() => expect(draft.getSnapshot().loading).toBe(false))
  expect(draft.key).toBe(projectDraftKey(project.id))
  expect(draft.getSnapshot().draft.prompt).toBe('项目化之前写的')
})

it('已有会话的项目沿用那个会话留下的草稿', async () => {
  const created = await useCanvasProjectStore.getState().create()
  await useCanvasProjectStore.getState().update(created.id, { conversationId: 'conversation-7' })
  const legacy = new DraftSession(legacyDraftKey('conversation-7'))
  await legacy.ready
  legacy.update({ prompt: '项目化之前的会话草稿', references: [] })
  await legacy.flush()

  const draft = currentProjectDraft('conversation-7')
  await vi.waitFor(() => expect(draft.getSnapshot().loading).toBe(false))
  expect(draft.key).toBe(projectDraftKey(created.id))
  expect(draft.getSnapshot().draft.prompt).toBe('项目化之前的会话草稿')
})
