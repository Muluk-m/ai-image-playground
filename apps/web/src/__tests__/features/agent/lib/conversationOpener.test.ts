import { describe, expect, it, vi } from 'vitest'
import {
  type AgentConversationState,
  AgentRequestError,
} from '../../../../features/agent/lib/agentClient'
import {
  type ConversationOpenerDeps,
  type ConversationOpenerState,
  createConversationOpener,
} from '../../../../features/agent/lib/conversationOpener'
import type { AgentPanelState } from '../../../../features/agent/lib/panelMessages'
import { IDLE_TURN_FIELDS } from '../../../../features/agent/lib/turnSession'
import type { AgentPanelMessage } from '../../../../features/agent/types'
import { i18next } from '../../../../i18n'

const GONE = () => i18next.t('error.conversationGone', { ns: 'agent' })
const UNREADABLE = () => i18next.t('error.conversationUnreadable', { ns: 'agent' })

const text = (id: string) =>
  ({ kind: 'text', id, role: 'assistant', text: id }) as AgentPanelMessage

const snapshot = (patch: Partial<AgentConversationState> = {}): AgentConversationState => ({
  messages: [],
  turns: [],
  activeTurn: null,
  ...patch,
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, no) => {
    resolve = ok
    reject = no
  })
  return { promise, resolve, reject }
}

function harness(initial: Partial<ConversationOpenerState> = {}) {
  let state: ConversationOpenerState = {
    ...IDLE_TURN_FIELDS,
    conversationId: 'old',
    messages: [text('old-1')],
    turns: {},
    activeTurn: null,
    error: 'stale',
    errorDiagnostic: null,
    historyCached: false,
    historyLoading: false,
    historyFailed: false,
    returnedMessagesPending: true,
    returnedMessagesError: 'fallback',
    ...initial,
  }
  let generation = 0
  let cacheCurrent = true
  const cachedPanel = deferred<AgentPanelState | null>()
  const cache = {
    isCurrent: vi.fn(() => cacheCurrent),
    read: vi.fn(() => cachedPanel.promise),
    write: vi.fn(async () => {}),
  }
  const remote = deferred<AgentConversationState>()
  let project: { id: string; conversationId?: string | null } | undefined = {
    id: 'p1',
    conversationId: 'c1',
  }
  const deps = {
    get: () => state,
    set: vi.fn((patch: Partial<ConversationOpenerState>) => {
      state = { ...state, ...patch }
    }),
    sessionReset: vi.fn((conversationId: string | null) => ({
      conversationId,
      messages: [],
      turns: {},
      activeTurn: null,
      error: null,
      historyCached: false,
      historyLoading: false,
      historyFailed: false,
    })),
    resetDelivery: vi.fn(() => {
      const mine = ++generation
      return () => mine === generation
    }),
    bindCache: vi.fn(() => cache),
    forgetCache: vi.fn(async () => {}),
    releaseRunOrigins: vi.fn(),
    selectWorkspace: vi.fn(),
    adoptSnapshot: vi.fn((_: string, taken: AgentConversationState) => {
      state = { ...state, messages: taken.messages.map((one) => text(one.id)) }
    }),
    recoverReturnedMessages: vi.fn(async () => {}),
    resumeOutgoing: vi.fn(),
    followActive: vi.fn(async () => {}),
    fail: vi.fn(),
    startNewConversation: vi.fn(),
    project: {
      current: vi.fn(() => project),
      detach: vi.fn(async () => {}),
      open: vi.fn(),
    },
    fetchMessages: vi.fn(() => remote.promise),
  } satisfies ConversationOpenerDeps
  return {
    deps,
    open: createConversationOpener(deps),
    state: () => state,
    cache,
    cachedPanel,
    remote,
    setProject: (next: typeof project) => {
      project = next
    },
    supersede: () => void ++generation,
    loseCache: () => {
      cacheCurrent = false
    },
  }
}

const message = (id: string) => ({ id }) as AgentConversationState['messages'][number]

describe('createConversationOpener', () => {
  it('换到新会话：整份清空、标读取中，选工作区并释放运行来源', () => {
    const h = harness()
    void h.open('c1')
    expect(h.deps.sessionReset).toHaveBeenCalledWith('c1')
    expect(h.state()).toMatchObject({
      conversationId: 'c1',
      messages: [],
      error: null,
      historyLoading: true,
      historyFailed: false,
      returnedMessagesPending: false,
      returnedMessagesError: null,
      activeTurn: null,
    })
    expect(h.deps.releaseRunOrigins).toHaveBeenCalledTimes(1)
    expect(h.deps.selectWorkspace).toHaveBeenCalledWith('c1')
    expect(h.deps.bindCache).toHaveBeenCalledWith('c1')
    // 交付先换代，再绑快照目标。
    expect(h.deps.resetDelivery.mock.invocationCallOrder[0]).toBeLessThan(
      h.deps.bindCache.mock.invocationCallOrder[0],
    )
  })

  it('重开同一个会话：不清面板、保留缓存预览标记、不释放运行来源', () => {
    const h = harness({ conversationId: 'c1', historyCached: true })
    void h.open('c1')
    expect(h.deps.sessionReset).not.toHaveBeenCalled()
    expect(h.state()).toMatchObject({ messages: [text('old-1')], historyCached: true })
    expect(h.deps.releaseRunOrigins).not.toHaveBeenCalled()
  })

  it('服务端历史回来：换上快照、写本机快照、清读取标记；没有在跑的轮就补发丢掉的消息', async () => {
    const h = harness()
    const done = h.open('c1')
    h.remote.resolve(snapshot({ messages: [message('m1')] }))
    await done
    expect(h.deps.adoptSnapshot).toHaveBeenCalledWith('c1', expect.anything())
    expect(h.state()).toMatchObject({
      historyCached: false,
      historyLoading: false,
      historyFailed: false,
    })
    expect(h.cache.write).toHaveBeenCalledWith({ messages: [text('m1')], turns: {} })
    expect(h.deps.recoverReturnedMessages).toHaveBeenCalledWith('c1')
    expect(h.deps.resumeOutgoing).toHaveBeenCalledWith('p1')
    expect(h.deps.followActive).not.toHaveBeenCalled()
  })

  it('当前项目挂的不是这个会话时不补发', async () => {
    const h = harness()
    h.setProject({ id: 'p2', conversationId: 'other' })
    const done = h.open('c1')
    h.remote.resolve(snapshot())
    await done
    expect(h.deps.resumeOutgoing).not.toHaveBeenCalled()
  })

  it('服务端还没回、面板空着：先显示本机快照当预览', async () => {
    const h = harness()
    const done = h.open('c1')
    h.cachedPanel.resolve({ messages: [text('cached')], turns: {} })
    await vi.waitFor(() => expect(h.state().historyCached).toBe(true))
    expect(h.state().messages).toEqual([text('cached')])
    h.remote.resolve(snapshot({ messages: [message('m1')] }))
    await done
    expect(h.state()).toMatchObject({ messages: [text('m1')], historyCached: false })
  })

  it('服务端先回来，迟到的本机快照不覆盖', async () => {
    const h = harness()
    const done = h.open('c1')
    h.remote.resolve(snapshot({ messages: [message('m1')] }))
    await done
    h.cachedPanel.resolve({ messages: [text('cached')], turns: {} })
    await Promise.resolve()
    await Promise.resolve()
    expect(h.state()).toMatchObject({ messages: [text('m1')], historyCached: false })
  })

  it('面板已有内容（重开同一会话）时本机快照不覆盖', async () => {
    const h = harness({ conversationId: 'c1' })
    void h.open('c1')
    h.cachedPanel.resolve({ messages: [text('cached')], turns: {} })
    await Promise.resolve()
    await Promise.resolve()
    expect(h.state().messages).toEqual([text('old-1')])
  })

  it('历史里有在跑的轮：标运行中并从快照游标接着跟', async () => {
    const h = harness()
    const done = h.open('c1')
    h.remote.resolve(snapshot({ activeTurn: { turnId: 't1' }, cursor: 7 }))
    await done
    expect(h.state().activeTurn).toEqual({ turnId: 't1' })
    expect(h.state().turn).toBe('running')
    expect(h.deps.followActive).toHaveBeenCalledWith('c1', { turnId: 't1', cursor: 7 })
    expect(h.deps.resumeOutgoing).not.toHaveBeenCalled()
  })

  it('历史里没有在跑的轮但带了 409 兜底的 turnId：从头重放那一轮', async () => {
    const h = harness()
    const done = h.open('c1', 't9')
    h.remote.resolve(snapshot({ cursor: 3 }))
    await done
    expect(h.deps.followActive).toHaveBeenCalledWith('c1', { turnId: 't9' })
  })

  it('会话没了（404）且挂在当前项目上：清快照、从项目摘掉、回到项目并报会话已不存在', async () => {
    const h = harness()
    const done = h.open('c1')
    h.remote.reject(new AgentRequestError(404, 'not_found'))
    await done
    expect(h.deps.forgetCache).toHaveBeenCalledWith('c1')
    expect(h.deps.project.detach).toHaveBeenCalledWith('p1')
    expect(h.deps.project.open).toHaveBeenCalledWith('p1')
    expect(h.deps.sessionReset).toHaveBeenLastCalledWith(null)
    expect(h.state()).toMatchObject({ conversationId: null, error: GONE(), messages: [] })
    expect(h.deps.releaseRunOrigins).toHaveBeenCalledTimes(2)
    expect(h.deps.fail).not.toHaveBeenCalled()
    expect(h.deps.startNewConversation).not.toHaveBeenCalled()
  })

  it('会话不是你的（403）且没挂在当前项目上：清快照后新开会话', async () => {
    const h = harness()
    h.setProject(undefined)
    const done = h.open('c1')
    h.remote.reject(new AgentRequestError(403, 'forbidden'))
    await done
    expect(h.deps.forgetCache).toHaveBeenCalledWith('c1')
    expect(h.deps.startNewConversation).toHaveBeenCalledTimes(1)
    expect(h.state()).toMatchObject({ messages: [], historyCached: false })
  })

  it('从项目摘会话失败：标读取失败并报读不到', async () => {
    const h = harness()
    h.deps.project.detach.mockRejectedValueOnce(new Error('db'))
    const done = h.open('c1')
    h.remote.reject(new AgentRequestError(404, 'not_found'))
    await done
    expect(h.state()).toMatchObject({ historyLoading: false, historyFailed: true })
    expect(h.deps.fail).toHaveBeenCalledWith(UNREADABLE())
    expect(h.deps.project.open).not.toHaveBeenCalled()
  })

  it.each([
    ['5xx', new AgentRequestError(503, 'unavailable')],
    ['断网', new TypeError('Failed to fetch')],
  ])('其它失败（%s）不忘掉会话，只报读不到', async (_, thrown) => {
    const h = harness()
    const done = h.open('c1')
    h.remote.reject(thrown)
    await done
    expect(h.state()).toMatchObject({ historyLoading: false, historyFailed: true })
    expect(h.deps.fail).toHaveBeenCalledWith(UNREADABLE())
    expect(h.deps.forgetCache).not.toHaveBeenCalled()
    expect(h.deps.startNewConversation).not.toHaveBeenCalled()
  })

  it('读取期间被换代（又切了会话）：回来的历史和报错都丢掉', async () => {
    const ok = harness()
    const done = ok.open('c1')
    ok.supersede()
    ok.remote.resolve(snapshot({ activeTurn: { turnId: 't1' } }))
    await done
    expect(ok.deps.adoptSnapshot).not.toHaveBeenCalled()
    expect(ok.cache.write).not.toHaveBeenCalled()

    const failed = harness()
    const failing = failed.open('c1')
    failed.loseCache()
    failed.remote.reject(new AgentRequestError(404, 'not_found'))
    await failing
    expect(failed.deps.forgetCache).not.toHaveBeenCalled()
    expect(failed.deps.fail).not.toHaveBeenCalled()
  })

  it('补回退回的消息期间被换代：不再跟轮也不补发', async () => {
    const h = harness()
    h.deps.recoverReturnedMessages.mockImplementationOnce(async () => h.supersede())
    const done = h.open('c1')
    h.remote.resolve(snapshot({ activeTurn: { turnId: 't1' } }))
    await done
    expect(h.deps.followActive).not.toHaveBeenCalled()
    expect(h.deps.resumeOutgoing).not.toHaveBeenCalled()
  })
})
