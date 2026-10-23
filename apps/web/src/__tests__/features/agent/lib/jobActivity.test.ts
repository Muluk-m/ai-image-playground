import type { AgentBackgroundJobView } from '@image-playground/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configureAgentJobActivity,
  markAgentConversationSeen,
  reportAgentPanel,
  resetAgentJobActivity,
  useAgentJobActivity,
} from '../../../../features/agent/lib/jobActivity'
import type { AgentPanelMessage, AgentToolMessage } from '../../../../features/agent/types'

function tool(id: string, patch: Partial<AgentToolMessage> = {}): AgentToolMessage {
  return {
    kind: 'tool',
    id,
    turnId: 'turn-1',
    toolCallId: `call-${id}`,
    toolName: 'generateImage',
    title: '一只橘猫',
    status: 'submitted',
    job: { taskId: `task-${id}`, media: 'image' },
    ...patch,
  }
}

function view(message: AgentToolMessage): AgentBackgroundJobView {
  return {
    messageId: message.id,
    turnId: message.turnId,
    result: message,
  } as unknown as AgentBackgroundJobView
}

const viewing = vi.fn((_conversationId: string) => false)
const fetchJobs = vi.fn(async (_conversationId: string): Promise<AgentBackgroundJobView[]> => [])

beforeEach(() => {
  resetAgentJobActivity()
  viewing.mockReset().mockReturnValue(false)
  fetchJobs.mockReset().mockResolvedValue([])
  configureAgentJobActivity({ viewing, fetchJobs, pollIntervalMs: 1 })
})

afterEach(() => resetAgentJobActivity())

/** 面板依次停在这些状态：模拟 store 的 subscribe。 */
function panel(...steps: [string | null, AgentPanelMessage[]][]) {
  let previous: { conversationId: string | null; messages: AgentPanelMessage[] } | undefined
  for (const [conversationId, messages] of steps) {
    reportAgentPanel(conversationId, messages, previous)
    previous = { conversationId, messages }
  }
}

describe('切走之后的对话（BUG-16）', () => {
  it('切到别的对话时还没出完的，后台等着，出完了在侧栏记一笔并弹提示', async () => {
    const pending = [tool('a'), tool('b'), tool('c', { status: 'succeeded' })]
    fetchJobs.mockResolvedValue(pending.slice(0, 2).map(view))
    panel(['conv-1', pending], ['conv-2', []])
    expect(useAgentJobActivity.getState().activity['conv-1']?.running).toBe(2)
    await vi.waitFor(() => expect(fetchJobs).toHaveBeenCalledWith('conv-1'))
    expect(useAgentJobActivity.getState().notice).toBeNull()

    fetchJobs.mockResolvedValue([
      view(
        tool('a', {
          status: 'succeeded',
          artifacts: [{}, {}] as unknown as AgentToolMessage['artifacts'],
        }),
      ),
      view(
        tool('b', {
          status: 'failed',
          errorCode: 'provider_error' as AgentToolMessage['errorCode'],
        }),
      ),
    ])
    await vi.waitFor(() => expect(useAgentJobActivity.getState().notice).not.toBeNull())
    expect(useAgentJobActivity.getState().notice).toMatchObject({
      conversationId: 'conv-1',
      images: 2,
      failed: 1,
    })
    expect(useAgentJobActivity.getState().activity['conv-1']).toMatchObject({
      running: 0,
      done: { images: 2 },
    })
  })

  it('全是用户自己取消的，不提示', async () => {
    fetchJobs.mockResolvedValue([
      view(
        tool('a', { status: 'failed', errorCode: 'cancelled' as AgentToolMessage['errorCode'] }),
      ),
    ])
    panel(['conv-1', [tool('a')]], ['conv-2', []])
    await vi.waitFor(() =>
      expect(useAgentJobActivity.getState().activity['conv-1']).toBeUndefined(),
    )
    expect(useAgentJobActivity.getState().notice).toBeNull()
  })

  it('切回去由面板接着等，后台不再问；回去看过，那个点收掉', async () => {
    panel(['conv-1', [tool('a')]], ['conv-2', []])
    await vi.waitFor(() => expect(fetchJobs).toHaveBeenCalled())
    reportAgentPanel('conv-1', [tool('a')], { conversationId: 'conv-2', messages: [] })
    const calls = fetchJobs.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchJobs.mock.calls.length).toBeLessThanOrEqual(calls + 1)

    useAgentJobActivity.setState({
      activity: {
        'conv-3': { running: 0, done: { conversationId: 'conv-3', images: 1, failed: 0, at: 1 } },
      },
      notice: { conversationId: 'conv-3', images: 1, failed: 0, at: 1 },
    })
    markAgentConversationSeen('conv-3')
    expect(useAgentJobActivity.getState().activity['conv-3']).toBeUndefined()
    expect(useAgentJobActivity.getState().notice).toBeNull()
  })
})

describe('开着的对话', () => {
  it('人在首页时开着的对话出完了，同样弹提示', () => {
    panel(['conv-1', [tool('a')]], ['conv-1', [tool('a', { status: 'succeeded' })]])
    expect(useAgentJobActivity.getState().notice).toMatchObject({
      conversationId: 'conv-1',
      images: 1,
    })
  })

  it('用户正看着这段对话，不打扰', () => {
    viewing.mockReturnValue(true)
    panel(['conv-1', [tool('a')]], ['conv-1', [tool('a', { status: 'succeeded' })]])
    expect(useAgentJobActivity.getState().notice).toBeNull()
    expect(useAgentJobActivity.getState().activity['conv-1']).toBeUndefined()
  })

  it('还在出的时候侧栏能看到在跑几张', () => {
    panel(['conv-1', [tool('a'), tool('b')]])
    expect(useAgentJobActivity.getState().activity['conv-1']).toEqual({ running: 2 })
  })
})
