// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DraftSession } from '../../../../features/agent/lib/drafts'
import {
  currentProjectDraft,
  deleteProject,
  saveCurrentProject,
  showProject,
} from '../../../../features/agent/lib/projectLifecycle'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { loadScene } from '../../../../features/canvas/lib/persistence'
import { projectRepository } from '../../../../features/canvas/lib/projectRepository'
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

const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
  Response.json({ conversations: [] }),
)

/** 草稿键的期望值来自 drafts.ts 的存储格式，不复述被测函数的算式。 */
const projectDraftKey = (projectId: string) => scopedStorageName(`agent-project-draft:${projectId}`)
const legacyDraftKey = (conversationId: string | null) =>
  scopedStorageName(`agent-draft:${conversationId ?? 'new'}`)

/** 存储里那份草稿的文字。读回来的非空草稿先作为「未发送的草稿」等用户决定，不直接进输入框。 */
async function storedPrompt(key: string): Promise<string> {
  const session = new DraftSession(key)
  await vi.waitFor(() => expect(session.getSnapshot().loading).toBe(false))
  const { unsent, draft } = session.getSnapshot()
  return (unsent ?? draft).prompt
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

  expect(await storedPrompt(projectDraftKey(project.id))).toBe('产品海报草稿')
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

  expect(await storedPrompt(legacyDraftKey(null))).toBe('没有项目时的输入')
  expect(await persistedCamera(sceneKey)).toBe(5)
})

/**
 * store 那一侧的三步只记录次序：顺序归 module，这里观察它，不复述它。
 * `reset` 顺手记下此刻的画布，用来分辨面板是在旧画布还是新画布上被清空的。
 */
function recordingPanel(seen: string[]) {
  return {
    resetDelivery: () => void seen.push('resetDelivery'),
    reset: () => void seen.push(`reset@camera=${currentCanvasWorkspace().doc.camera.x}`),
    open: (conversationId: string) => void seen.push(`open:${conversationId}`),
  }
}

it('展示项目：面板先被清空，新画布之后才发布', async () => {
  currentCanvasWorkspace().doc.setCamera({ x: 42 })
  const target = await useCanvasProjectStore.getState().create()
  const seen: string[] = []

  showProject(target, recordingPanel(seen))

  expect(seen).toEqual(['resetDelivery', 'reset@camera=42'])
  expect(currentCanvasWorkspace().doc.camera.x).toBe(0)
  expect(currentCanvasProject()?.id).toBe(target.id)
})

it('展示项目：绑了会话就读回那个会话，没绑就不读', async () => {
  const bound = await useCanvasProjectStore.getState().create()
  await useCanvasProjectStore.getState().update(bound.id, { conversationId: 'conversation-3' })
  const unbound = await useCanvasProjectStore.getState().create()
  const seen: string[] = []

  showProject({ ...bound, conversationId: 'conversation-3' }, recordingPanel(seen))
  expect(seen).toContain('open:conversation-3')

  seen.length = 0
  showProject(unbound, recordingPanel(seen))
  expect(seen.some((one) => one.startsWith('open:'))).toBe(false)
})

it('首次发送前的新项目把未绑定会话留下的草稿作为未发送草稿提供', async () => {
  const project = currentCanvasProject()!
  expect(project.sceneKey).toBe(canvasSceneKey(null))
  const legacy = new DraftSession(legacyDraftKey(null))
  await legacy.ready
  legacy.update({ prompt: '项目化之前写的', references: [] })
  await legacy.flush()

  const draft = currentProjectDraft(null)
  await vi.waitFor(() => expect(draft.getSnapshot().loading).toBe(false))
  expect(draft.key).toBe(projectDraftKey(project.id))
  expect(draft.getSnapshot().unsent?.prompt).toBe('项目化之前写的')
})

it('已有会话的项目把那个会话留下的草稿作为未发送草稿提供', async () => {
  const created = await useCanvasProjectStore.getState().create()
  await useCanvasProjectStore.getState().update(created.id, { conversationId: 'conversation-7' })
  const legacy = new DraftSession(legacyDraftKey('conversation-7'))
  await legacy.ready
  legacy.update({ prompt: '项目化之前的会话草稿', references: [] })
  await legacy.flush()

  const draft = currentProjectDraft('conversation-7')
  await vi.waitFor(() => expect(draft.getSnapshot().loading).toBe(false))
  expect(draft.key).toBe(projectDraftKey(created.id))
  expect(draft.getSnapshot().unsent?.prompt).toBe('项目化之前的会话草稿')
})

/**
 * 删除时 store 那一侧的两步。`replaceCurrent` 照 store 的做法建一个新项目顶上，
 * 并记下这一刻要删的那个项目还在不在——「先顶上再删」只能从这里看出来。
 */
function deletePanel(targetId: string) {
  const seen: string[] = []
  const panel = {
    conversationId: null as string | null,
    running: false,
    replaceCurrent: async () => {
      const present = useCanvasProjectStore.getState().projects.some((one) => one.id === targetId)
      seen.push(`replaceCurrent@target=${present}`)
      await useCanvasProjectStore.getState().create()
    },
    forgetConversation: (conversationId: string | null) =>
      void seen.push(`forgetConversation:${conversationId}`),
  }
  return { seen, panel }
}

/** 新建一个项目并给它留下草稿与画布，删没删干净都能从 IndexedDB 读回来对账。 */
async function projectWithContent(prompt: string, camera: number) {
  const project = await useCanvasProjectStore.getState().create()
  showProject(project, recordingPanel([]))
  await currentCanvasWorkspace().ready
  const draft = currentProjectDraft(null)
  await draft.ready
  draft.update({ prompt, references: [] })
  currentCanvasWorkspace().doc.setCamera({ x: camera })
  expect(await saveCurrentProject(null)).toEqual({ ok: true })
  return project
}

it('删除项目：草稿、项目记录与画布存档一起消失', async () => {
  const target = await projectWithContent('要被删掉的草稿', 61)
  const current = await projectWithContent('留下来的草稿', 12)
  const { seen, panel } = deletePanel(target.id)

  expect(await deleteProject(target.id, panel)).toEqual({ ok: true })

  expect((await projectRepository.list()).map((one) => one.id)).not.toContain(target.id)
  expect(await storedPrompt(projectDraftKey(target.id))).toBe('')
  expect(await persistedCamera(target.sceneKey)).toBe(0)
  expect(seen).toEqual(['forgetConversation:null'])
  expect(currentCanvasProject()?.id).toBe(current.id)
})

it('删除云端项目：本机拒绝，草稿、项目与画布原样留着', async () => {
  const target = await projectWithContent('云端项目的草稿', 33)
  // 云端项目只能在云端删（ADR-0002 / ADR-0005）：本机删掉只会把「已删除」报成假的。
  await useCanvasProjectStore.getState().update(target.id, { cloud: { revision: 0 } })
  await projectWithContent('留下来的草稿', 12)
  const { seen, panel } = deletePanel(target.id)

  expect(await deleteProject(target.id, panel)).toEqual({ ok: false, reason: 'cloud_project' })

  expect((await projectRepository.list()).map((one) => one.id)).toContain(target.id)
  expect(await storedPrompt(projectDraftKey(target.id))).toBe('云端项目的草稿')
  expect(await persistedCamera(target.sceneKey)).toBe(33)
  expect(seen).toEqual([])
})

it('删除项目：画布上还有 loading 占位框时不删', async () => {
  const target = await projectWithContent('占位框还在跑', 24)
  currentCanvasWorkspace().doc.addElements([
    {
      id: 'placeholder-1',
      type: 'placeholder',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      status: 'loading',
      message: '',
      meta: { taskId: '', clientRequestId: '', source: 'user-byok', prompt: '' },
    },
  ])
  const { seen, panel } = deletePanel(target.id)

  expect(await deleteProject(target.id, panel)).toEqual({ ok: false, reason: 'busy' })

  expect((await projectRepository.list()).map((one) => one.id)).toContain(target.id)
  expect(await storedPrompt(projectDraftKey(target.id))).toBe('占位框还在跑')
  expect(await persistedCamera(target.sceneKey)).toBe(24)
  expect(seen).toEqual([])
})

it('删除项目：当前项目正在跑一轮时不删', async () => {
  const target = await projectWithContent('轮还在跑', 27)
  const { seen, panel } = deletePanel(target.id)
  panel.running = true

  expect(await deleteProject(target.id, panel)).toEqual({ ok: false, reason: 'busy' })

  expect((await projectRepository.list()).map((one) => one.id)).toContain(target.id)
  expect(await persistedCamera(target.sceneKey)).toBe(27)
  expect(seen).toEqual([])
})

it('删除项目：当前项目保存不下来时不删', async () => {
  const target = await projectWithContent('保存失败前的草稿', 18)
  // 落盘失败的是「当前项目」而不是要删的那个：删除必须先把手头的东西保住。
  await projectWithContent('当前项目的草稿', 44)
  currentCanvasWorkspace().doc.setCamera({ x: 90 })
  abortNextPut()
  const { seen, panel } = deletePanel(target.id)

  expect(await deleteProject(target.id, panel)).toEqual({ ok: false, reason: 'save_failed' })

  expect((await projectRepository.list()).map((one) => one.id)).toContain(target.id)
  expect(await storedPrompt(projectDraftKey(target.id))).toBe('保存失败前的草稿')
  expect(await persistedCamera(target.sceneKey)).toBe(18)
  expect(seen).toEqual([])
})

it('删除当前项目：先有新项目顶上，旧项目才被删', async () => {
  const target = await projectWithContent('当前项目的草稿', 15)
  const seenActive: (string | null)[] = []
  const stopWatching = useCanvasProjectStore.subscribe(
    (state) => void seenActive.push(state.activeId),
  )
  const { seen, panel } = deletePanel(target.id)

  expect(await deleteProject(target.id, panel)).toEqual({ ok: true })
  stopWatching()

  expect(seen).toEqual(['replaceCurrent@target=true', 'forgetConversation:null'])
  // 当前项目一路上没有空过：新项目是在旧项目还在的时候顶上来的。
  expect(seenActive).not.toContain(null)
  expect(currentCanvasProject()?.id).not.toBe(target.id)
  expect(currentCanvasProject()).toBeDefined()
  expect((await projectRepository.list()).map((one) => one.id)).not.toContain(target.id)
})

it('删除别的项目：当前项目与它的画布不受影响', async () => {
  const target = await projectWithContent('要删的项目', 71)
  const current = await projectWithContent('当前项目的草稿', 39)
  const { seen, panel } = deletePanel(target.id)

  expect(await deleteProject(target.id, panel)).toEqual({ ok: true })

  expect(seen).toEqual(['forgetConversation:null'])
  expect(currentCanvasProject()?.id).toBe(current.id)
  expect(currentCanvasWorkspace().doc.camera.x).toBe(39)
  expect(await storedPrompt(projectDraftKey(current.id))).toBe('当前项目的草稿')
})

/** 会话删除请求打出去没有：URL 与方法来自 agentClient 的协议，不复述被测实现。 */
const conversationDeleted = (conversationId: string) =>
  fetchMock.mock.calls.some(
    ([url, init]) =>
      String(url).endsWith(`/conversations/${conversationId}`) && init?.method === 'DELETE',
  )

it('删除绑了会话的项目：会话一起删掉，面板的列表也摘掉它', async () => {
  const target = await projectWithContent('绑了会话的草稿', 51)
  await useCanvasProjectStore.getState().update(target.id, { conversationId: 'conversation-42' })
  await projectWithContent('当前项目的草稿', 8)
  const { seen, panel } = deletePanel(target.id)
  fetchMock.mockImplementationOnce(async () =>
    Response.json({ messages: [], turns: [], activeTurn: null }),
  )

  expect(await deleteProject(target.id, panel)).toEqual({ ok: true })

  expect(conversationDeleted('conversation-42')).toBe(true)
  expect(seen).toEqual(['forgetConversation:conversation-42'])
  expect((await projectRepository.list()).map((one) => one.id)).not.toContain(target.id)
})

it('删除项目：服务端说这个会话还有一轮在跑时不删', async () => {
  const target = await projectWithContent('别的标签页正用着', 45)
  await useCanvasProjectStore.getState().update(target.id, { conversationId: 'conversation-busy' })
  await projectWithContent('当前项目的草稿', 3)
  const { seen, panel } = deletePanel(target.id)
  fetchMock.mockImplementationOnce(async () =>
    Response.json({ messages: [], turns: [], activeTurn: { id: 'turn-1' } }),
  )

  expect(await deleteProject(target.id, panel)).toEqual({ ok: false, reason: 'busy' })

  expect(conversationDeleted('conversation-busy')).toBe(false)
  expect((await projectRepository.list()).map((one) => one.id)).toContain(target.id)
  expect(seen).toEqual([])
})

it('删除项目：会话在服务端已经没了也照删不误', async () => {
  const target = await projectWithContent('会话已经没了', 66)
  await useCanvasProjectStore.getState().update(target.id, { conversationId: 'conversation-gone' })
  await projectWithContent('当前项目的草稿', 9)
  const { seen, panel } = deletePanel(target.id)
  fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 404 }))

  expect(await deleteProject(target.id, panel)).toEqual({ ok: true })

  expect(conversationDeleted('conversation-gone')).toBe(false)
  expect(seen).toEqual(['forgetConversation:conversation-gone'])
  expect((await projectRepository.list()).map((one) => one.id)).not.toContain(target.id)
})
