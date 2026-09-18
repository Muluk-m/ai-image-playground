// @vitest-environment jsdom
import type { AgentToolErrorCode } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AgentToolCard from '../../../../features/agent/components/AgentToolCard'
import type { AgentToolMessage } from '../../../../features/agent/types'
import { AUTH_SESSION_EXPIRED_EVENT } from '../../../../lib/authClient'
import { notifyPrivateSubmissionError } from '../../../../lib/privateOverlay'

const store = vi.hoisted(() => ({
  send: vi.fn(),
  placeOnCanvas: vi.fn(),
  cancelJob: vi.fn(async (_messageId: string) => {}),
  jobProgress: {} as Record<string, { stage: 'submitted' | 'running'; submittedAt: number }>,
  toolStartedAt: {} as Record<string, number>,
}))
const send = store.send

vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: Object.assign((select: (state: typeof store) => unknown) => select(store), {
    getState: () => store,
  }),
}))

const deployment = vi.hoisted(() => ({
  overlay: true,
  capabilities: new Set<string>(['billing:credits', 'accounts:login']),
}))

vi.mock('../../../../lib/privateOverlay', () => ({
  notifyPrivateSubmissionError: vi.fn(),
  get PrivateWebOverlayPresent() {
    return deployment.overlay
  },
}))

vi.mock('../../../../lib/clientCapabilities', () => ({
  isClientCapabilityEnabled: (key: string) => deployment.capabilities.has(key),
}))

beforeEach(() => {
  send.mockClear()
  store.cancelJob.mockClear()
  store.jobProgress = {}
  store.toolStartedAt = {}
  deployment.overlay = true
  deployment.capabilities = new Set(['billing:credits', 'accounts:login'])
  vi.mocked(notifyPrivateSubmissionError).mockClear()
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('says a submitted background job is still generating and will land on the canvas', () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() =>
      root.render(
        <AgentToolCard
          message={{
            kind: 'tool',
            id: 'm',
            turnId: 't',
            toolCallId: 'c',
            title: '一只橘猫',
            status: 'submitted',
          }}
        />,
      ),
    )
    expect(host.textContent).toContain('已在后台生成，完成后自动放入画布')
  } finally {
    act(() => root.unmount())
  }
})
describe('后台任务的进度与取消', () => {
  const NOW = Date.UTC(2026, 8, 18, 10, 0, 0)
  const submitted = {
    kind: 'tool' as const,
    id: 'm',
    turnId: 't',
    toolCallId: 'c',
    title: '一只橘猫',
    status: 'submitted' as const,
    job: { taskId: 'task-1', media: 'image' as const },
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows the stage and the time since the server accepted the task, ticking every second', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] })
    store.jobProgress = { m: { stage: 'running', submittedAt: NOW - 42_000 } }
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      act(() => root.render(<AgentToolCard message={submitted} />))
      const bar = host.querySelector('[role="progressbar"]')!
      expect(bar.getAttribute('aria-valuenow')).toBe('3')
      expect(host.textContent).toContain('生成中 · 已用 0:42')

      act(() => vi.advanceTimersByTime(3_000))
      expect(host.textContent).toContain('生成中 · 已用 0:45')
    } finally {
      act(() => root.unmount())
    }
  })

  it('cancels the job from the card', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      act(() => root.render(<AgentToolCard message={submitted} />))
      const button = [...host.querySelectorAll('button')].find(
        (one) => one.textContent === '取消任务',
      )!
      await act(async () => button.click())
      expect(store.cancelJob).toHaveBeenCalledWith('m')
    } finally {
      act(() => root.unmount())
    }
  })

  it('says a cancel that did not go through, and keeps the card', async () => {
    store.cancelJob.mockRejectedValueOnce(new Error('boom'))
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      act(() => root.render(<AgentToolCard message={submitted} />))
      const button = [...host.querySelectorAll('button')].find(
        (one) => one.textContent === '取消任务',
      )!
      await act(async () => button.click())
      expect(host.textContent).toContain('没能取消，请稍后再试')
    } finally {
      act(() => root.unmount())
    }
  })

  it('shows the refunded state of a cancelled job and no longer offers to cancel', () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      act(() =>
        root.render(
          <AgentToolCard
            message={{ ...submitted, status: 'failed', message: '已中止', errorCode: 'cancelled' }}
          />,
        ),
      )
      expect(host.textContent).toContain('已取消，积分已退回')
      expect(host.querySelector('[role="progressbar"]')).toBeNull()
      expect(host.textContent).not.toContain('取消任务')

      // 不计积分的部署不提积分。
      deployment.capabilities = new Set(['accounts:login'])
      act(() =>
        root.render(
          <AgentToolCard
            message={{ ...submitted, status: 'failed', message: '已中止', errorCode: 'cancelled' }}
          />,
        ),
      )
      expect(host.textContent).toContain('已取消')
      expect(host.textContent).not.toContain('积分')
    } finally {
      act(() => root.unmount())
    }
  })
})

it('keeps the complete multiline prompt available and copies it without the title truncation', async () => {
  const prompt = '完整提示词。'.repeat(30) + '\n第二段细节'
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    act(() =>
      root.render(
        <AgentToolCard
          message={{
            kind: 'tool',
            id: 'm',
            turnId: 't',
            toolCallId: 'c',
            title: '摘要…',
            prompt,
            status: 'running',
          }}
        />,
      ),
    )
    expect(host.textContent).not.toContain('复制')
    expect(host.textContent).not.toContain('存为模板')
    act(() => host.querySelector<HTMLButtonElement>('button')!.click())
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.querySelector('[aria-label="完整提示词"]')?.textContent).toBe(prompt)
    const copy = Array.from(dialog.querySelectorAll('button')).find(
      (button) => button.textContent === '复制',
    )!
    await act(async () => copy.click())
    expect(writeText).toHaveBeenCalledWith(prompt)
    expect(dialog.textContent).toContain('已复制')
    act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭提示词"]')!.click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

describe('失败卡按错误码给出路', () => {
  const failed = (errorCode?: AgentToolErrorCode) =>
    ({
      kind: 'tool',
      id: 'm',
      turnId: 't',
      toolCallId: 'c',
      toolName: 'generateImage',
      title: '一只橘猫',
      status: 'failed',
      message: '服务端写的那句话',
      ...(errorCode ? { errorCode } : {}),
    }) as const

  function render(message: ReturnType<typeof failed>) {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<AgentToolCard message={message} />))
    return { host, unmount: () => act(() => root.unmount()) }
  }

  const buttons = (host: HTMLElement) =>
    Array.from(host.querySelectorAll('button')).map((button) => button.textContent)

  it.each([
    ['insufficient_credits', '积分不够，这次没有提交', '去充值'],
    ['quota_exceeded', '今天的生成额度已经用完', '去充值'],
    ['authentication_required', '需要先登录才能生成', '去登录'],
    ['invalid_params', '这次的参数不成立，没有提交', '让助手重新处理'],
    ['model_unavailable', '要用的模型暂时不可用', '让助手重新处理'],
  ] as const)('%s 显示译文与「%s」对应的出路', (code, text, action) => {
    const { host, unmount } = render(failed(code))
    try {
      expect(host.textContent).toContain(text)
      // 界面不读服务端文字（ADR 0006）。
      expect(host.textContent).not.toContain('服务端写的那句话')
      expect(buttons(host)).toEqual([action])
    } finally {
      unmount()
    }
  })

  it.each([
    ['upstream_error', '生成服务出错了，这次没有出来'],
    ['timeout', '生成超时，这次没有出来'],
    ['no_output', '生成完成了，但没有拿到结果'],
    ['result_unknown', '这次的结果没能确认，可能已经生成；请先看看画布与历史'],
    ['cancelled', '已中止'],
    ['unknown', '没有完成'],
  ] as const)('%s 只说原因，这张票不给按钮', (code, text) => {
    const { host, unmount } = render(failed(code))
    try {
      expect(host.textContent).toContain(text)
      expect(buttons(host)).toEqual([])
    } finally {
      unmount()
    }
  })

  it('旧记录没有错误码：照旧显示存下的那句话，不给按钮', () => {
    const { host, unmount } = render(failed())
    try {
      expect(host.textContent).toContain('服务端写的那句话')
      expect(buttons(host)).toEqual([])
    } finally {
      unmount()
    }
  })

  it('「让助手重新处理」替用户发一条说明性消息', () => {
    send.mockClear()
    const { host, unmount } = render(failed('invalid_params'))
    try {
      act(() => host.querySelector('button')!.click())
      expect(send).toHaveBeenCalledWith(
        '「一只橘猫」没有完成：这次的参数不成立，没有提交。请换个做法重新处理。',
      )
    } finally {
      unmount()
    }
  })

  it('「去充值」打开充值入口，「去登录」回到登录', () => {
    const expired = vi.fn()
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
    const recharge = render(failed('insufficient_credits'))
    const login = render(failed('authentication_required'))
    try {
      act(() => recharge.host.querySelector('button')!.click())
      expect(notifyPrivateSubmissionError).toHaveBeenCalledWith({ insufficientCredits: true })
      act(() => login.host.querySelector('button')!.click())
      expect(expired).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalled()
    } finally {
      recharge.unmount()
      login.unmount()
      window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired)
    }
  })

  it.each([
    ['免费构建没有收费 overlay', false, ['billing:credits', 'accounts:login']],
    ['部署没开积分计费', true, ['accounts:login']],
  ] as const)('%s：没有充值入口就只说原因，不给「去充值」', (_case, overlay, capabilities) => {
    deployment.overlay = overlay
    deployment.capabilities = new Set(capabilities)
    for (const code of ['insufficient_credits', 'quota_exceeded'] as const) {
      const { host, unmount } = render(failed(code))
      try {
        expect(buttons(host)).toEqual([])
      } finally {
        unmount()
      }
    }
  })

  it('部署没开账号登录：只说原因，不给「去登录」', () => {
    deployment.capabilities = new Set(['billing:credits'])
    const { host, unmount } = render(failed('authentication_required'))
    try {
      expect(host.textContent).toContain('需要先登录才能生成')
      expect(buttons(host)).toEqual([])
    } finally {
      unmount()
    }
  })
})

describe('重试记录', () => {
  const original: AgentToolMessage = {
    kind: 'tool',
    id: 'tool-1',
    turnId: 't',
    toolCallId: 'call-1',
    title: '一只橘猫',
    status: 'failed',
    errorCode: 'timeout',
  }
  const record: AgentToolMessage = {
    kind: 'tool',
    id: 'retry-1',
    turnId: 'retry-turn',
    toolCallId: 'retry-call',
    title: '一只橘猫',
    status: 'submitted',
    job: { taskId: 'task-retry', media: 'image' },
    retryOf: { messageId: 'tool-1', toolCallId: 'call-1', placeholderId: 'p-1' },
  }

  function renderCards(retry: AgentToolMessage) {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    act(() =>
      root.render(
        <>
          <AgentToolCard message={original} />
          <AgentToolCard message={retry} />
        </>,
      ),
    )
    return {
      host,
      button: (label: string) =>
        [...host.querySelectorAll('button')].find((one) => one.textContent === label),
      unmount: () => {
        act(() => root.unmount())
        host.remove()
      },
    }
  }

  it('标明是重试，能跳回原失败卡，原卡照旧是失败', () => {
    const view = renderCards(record)
    try {
      const cards = view.host.querySelectorAll('[id^="agent-tool-card-"]')
      expect(cards[0]!.textContent).toContain('生成超时')
      expect(cards[0]!.textContent).not.toContain('查看原失败卡')
      expect(cards[1]!.textContent).toContain('重试')
      const scrollIntoView = vi.fn()
      ;(cards[0] as HTMLElement).scrollIntoView = scrollIntoView

      act(() => view.button('查看原失败卡')!.click())

      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      expect(document.activeElement).toBe(cards[0])
    } finally {
      view.unmount()
    }
  })

  it('还在跑的重试和别的后台任务一样可以取消，只有一个取消入口', () => {
    const view = renderCards(record)
    try {
      expect(view.host.textContent).not.toContain('中止重试')
      act(() => view.button('取消任务')!.click())
      expect(store.cancelJob).toHaveBeenCalledWith('retry-1')
    } finally {
      view.unmount()
    }
  })

  it('结束了的重试不再给中止', () => {
    const view = renderCards({ ...record, status: 'failed', errorCode: 'upstream_error' })
    try {
      expect(view.button('取消任务')).toBeUndefined()
      expect(view.button('查看原失败卡')).toBeDefined()
    } finally {
      view.unmount()
    }
  })
})
