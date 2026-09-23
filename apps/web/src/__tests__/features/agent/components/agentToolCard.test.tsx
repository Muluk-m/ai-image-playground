// @vitest-environment jsdom
import type { AgentToolErrorCode, DiscoveredChannel } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeLoginPrompt } from '../../../../auth/loginPrompt'
import AgentToolCard from '../../../../features/agent/components/AgentToolCard'
import type { AgentToolMessage } from '../../../../features/agent/types'
import { setChannels } from '../../../../lib/channels/channelStore'
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

// 取回来的网图按媒体 id 回源；这里只关心「按什么 id 取、卡上长什么样」。
vi.mock('../../../../lib/cloudMedia', () => ({
  mediaIdentity: (source: string) => source.match(/^aip-media:([0-9a-f-]{36})$/i)?.[1],
  resolveMediaSource: async (source: string, variant = 'original') => `${variant}:${source}`,
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

describe('没有唤醒智能体', () => {
  const ended: AgentToolMessage = {
    kind: 'tool',
    id: 'm',
    turnId: 't',
    toolCallId: 'c',
    title: '一只橘猫',
    status: 'failed',
    errorCode: 'timeout',
  }

  function render(message: AgentToolMessage): string {
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      act(() => root.render(<AgentToolCard message={message} />))
      return host.textContent ?? ''
    } finally {
      act(() => root.unmount())
    }
  }

  it('says the assistant did not review the result because credits ran out', () => {
    expect(render({ ...ended, wakeSkipped: 'insufficient_credits' })).toContain(
      '积分不足，助手未查看结果',
    )
  })

  it('says the assistant stopped checking back after too many wakes in a row', () => {
    expect(render({ ...ended, wakeSkipped: 'wake_limit' })).toContain(
      '助手已连续自动查看 3 次，等你发话后再继续',
    )
  })

  it('says nothing about waking when the wake was not skipped', () => {
    const text = render(ended)
    expect(text).not.toContain('助手未查看结果')
    expect(text).not.toContain('连续自动查看')
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

  const RETRY_CHANNEL: DiscoveredChannel = {
    id: 'openai',
    kind: 'openai-queue',
    label: 'OpenAI',
    models: [{ id: 'gpt-image-1', label: 'GPT Image', capabilities: ['generate'] }],
    defaults: { apiMode: 'images', timeout: 600 },
  }

  /** 一次真的跑过的局部改图失败：认得出是哪一次生成，但带着选区绑定，重出会改错地方。 */
  const localEditFailure = () =>
    ({
      ...failed('upstream_error'),
      toolName: 'editImage',
      snapshot: {
        mode: 'image',
        args: { prompt: '把猫改成蓝色', selectionBindings: [{ imageId: 'i', selectionId: 's' }] },
        target: { provider: 'openai-compat', model: 'gpt-image-1' },
      },
      job: { taskId: 'task-1', media: 'image' },
    }) as const

  function render(message: AgentToolMessage) {
    const host = document.createElement('div')
    const root = createRoot(host)
    act(() => root.render(<AgentToolCard message={message} />))
    return { host, unmount: () => act(() => root.unmount()) }
  }

  const buttons = (host: HTMLElement) =>
    Array.from(host.querySelectorAll('button')).map((button) => button.textContent)

  it.each([
    ['insufficient_credits', '积分不够，这次没有生成', '去充值'],
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

  // 这三个码的正常出路是画布占位上的重试。认得出是哪一次生成、却重出不了时（局部或连锁改图、
  // 模型已下线）重试给不出来，不能让这张卡停在一句原因上。
  it('局部改图失败给不出重试时改为让助手重新处理，并说清重出不了什么', () => {
    send.mockClear()
    setChannels([RETRY_CHANNEL])
    const { host, unmount } = render(localEditFailure())
    try {
      expect(buttons(host)).toEqual(['让助手重新处理'])
      act(() => host.querySelector('button')!.click())
      expect(send).toHaveBeenCalledWith(
        '「一只橘猫」没有完成：它是按当时的选区或方案改的，原样重做会改错地方。请换个做法重新处理。',
      )
    } finally {
      unmount()
    }
  })

  // 用户自己点出来又失败的那条重试记录不在此列：同一次失败在画布占位上仍给「重试」，
  // 这里再长一个「让助手重新处理」就是两个互相矛盾的出路，其中一个还要花一轮对话费用。
  it('失败的重试记录不给这条出路，免得与占位上的重试打架', () => {
    setChannels([RETRY_CHANNEL])
    const { host, unmount } = render({
      ...localEditFailure(),
      retryOf: { messageId: 'origin', toolCallId: 'c' },
    })
    try {
      expect(buttons(host).filter((label) => label === '让助手重新处理')).toEqual([])
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

  it('「去充值」打开充值入口，「去登录」叫出登录框', () => {
    const prompted = vi.fn()
    const unsubscribe = subscribeLoginPrompt(prompted)
    const recharge = render(failed('insufficient_credits'))
    const login = render(failed('authentication_required'))
    try {
      act(() => recharge.host.querySelector('button')!.click())
      expect(notifyPrivateSubmissionError).toHaveBeenCalledWith({ insufficientCredits: true })
      act(() => login.host.querySelector('button')!.click())
      // 弹登录框，不是把会话判失效——后者会把访客手上这段对话连同画布一起冲掉。
      expect(prompted.mock.calls).toEqual([['gated-action']])
      expect(send).not.toHaveBeenCalled()
    } finally {
      recharge.unmount()
      login.unmount()
      unsubscribe()
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

/**
 * 取回来的网图版权在对方那里：卡上必须看得见它长什么样，也必须点得回它的来源。
 * 少了来源那一条，用户手上就只剩一张不知道从哪来的图。
 */
it('shows the fetched image and a link back to where it came from', async () => {
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(
        <AgentToolCard
          message={{
            kind: 'tool',
            id: 'm',
            turnId: 't',
            toolCallId: 'call-1',
            toolName: 'fetchImage',
            title: '获取图片：example.com',
            status: 'succeeded',
            delivery: 'unavailable',
            fetchedImages: [
              {
                imageId: '11111111-2222-4333-8444-555555555555',
                sourceUrl: 'https://example.com/photos/cat.png',
                mime: 'image/png',
              },
            ],
          }}
        />,
      )
    })

    expect(host.querySelector('img')?.getAttribute('src')).toBe(
      'preview:aip-media:11111111-2222-4333-8444-555555555555',
    )
    const link = host.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com/photos/cat.png')
    // 地址常常很长，卡上一行放不下；用户要认的是站点。
    expect(link?.textContent).toBe('example.com')
    // 画布上还没有它，所以给得出「放入画布」那一下。
    expect(host.textContent).toContain('放入画布')
  } finally {
    act(() => root.unmount())
  }
})
