// @vitest-environment jsdom

import type { AgentToolErrorCode } from '@image-playground/shared'
import { projectArtifactId } from '@image-playground/shared'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeLoginPrompt } from '../../../../auth/loginPrompt'
import AgentToolCard from '../../../../features/agent/components/AgentToolCard'
import { setAgentCanvasSink } from '../../../../features/agent/lib/canvasSink'
import type { AgentRetryRefusal } from '../../../../features/agent/lib/retry'
import type { AgentPanelMessage, AgentToolMessage } from '../../../../features/agent/types'
import PlaceholderOverlay from '../../../../features/canvas/components/PlaceholderOverlay'
import { createAgentCanvasSink } from '../../../../features/canvas/lib/agentCanvasSink'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { projectScene } from '../../../../features/canvas/lib/projectMedia'
import { setChannels } from '../../../../lib/channels/channelStore'
import {
  notifyPrivateSubmissionError,
  type PrivateSubmissionInput,
} from '../../../../lib/privateOverlay'

const agent = vi.hoisted(() => ({
  send: vi.fn(),
  retry: vi.fn(),
  cancelJob: vi.fn(async () => {}),
  retryRemaining: vi.fn(async () => {}),
  conversationId: 'conv-1' as string | null,
  messages: [] as AgentPanelMessage[],
  retryRefusals: {} as Record<string, AgentRetryRefusal>,
  jobProgress: {} as Record<string, { stage: 'submitted' | 'running'; submittedAt: number }>,
  toolStartedAt: {} as Record<string, number>,
}))
const send = agent.send

vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: Object.assign((select: (state: typeof agent) => unknown) => select(agent), {
    getState: () => agent,
  }),
}))

// 收费形态、开了积分与登录：去充值 / 去登录都有真实入口。
vi.mock('../../../../lib/privateOverlay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/privateOverlay')>()),
  notifyPrivateSubmissionError: vi.fn(),
  PrivateWebOverlayPresent: true,
  // 计价目录：一张图 4 积分，视频按秒乘倍率。
  usePrivateSubmissionGuard: (input: PrivateSubmissionInput) => ({
    blocked: false,
    estimatedCredits: input.quantity * (input.unitMultiplier ?? 1) * 4,
  }),
}))
vi.mock('../../../../lib/clientCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/clientCapabilities')>()),
  isClientCapabilityEnabled: () => true,
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let editor: CanvasEditor
let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const doc = new CanvasDoc()
  doc.setViewport(800, 600)
  editor = new CanvasEditor(doc)
  host = document.createElement('div')
  root = createRoot(host)
  send.mockClear()
  agent.retry.mockReset()
  agent.cancelJob.mockClear()
  agent.retryRemaining.mockClear()
  agent.retryRefusals = {}
  agent.conversationId = 'conv-1'
  agent.messages = []
  agent.jobProgress = {}
  agent.toolStartedAt = {}
  setChannels([])
})

afterEach(() => {
  act(() => root.unmount())
  setAgentCanvasSink(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function failedPlaceholder(message: string, code?: AgentToolErrorCode) {
  const sink = createAgentCanvasSink(editor)
  const ids = await sink.reserve({
    count: 1,
    messageId: 'tool-1',
    conversationId: 'conv-1',
    title: '一只橘猫',
  })
  sink.markFailed(ids, message, code)
  act(() => root.render(<PlaceholderOverlay editor={editor} />))
  return ids
}

it('失败占位按错误码显示原因与出路，不显示服务端的文字', async () => {
  await failedPlaceholder('服务端写的那句话', 'invalid_params')

  expect(host.textContent).toContain('这次的参数不成立，没有提交')
  expect(host.textContent).not.toContain('服务端写的那句话')
  const button = host.querySelector('button')!
  expect(button.textContent).toBe('让助手重新处理')

  act(() => button.click())
  expect(send).toHaveBeenCalledWith(
    '「一只橘猫」没有完成：这次的参数不成立，没有提交。请换个做法重新处理。',
  )
})

it('要重试才解决得了的失败，这里只说原因', async () => {
  await failedPlaceholder('服务端写的那句话', 'upstream_error')

  expect(host.textContent).toContain('生成服务出错了，这次没有出来')
  expect(host.querySelector('button')).toBeNull()
})

it('旧占位框没有错误码：照旧显示存下的那句话，没有按钮', async () => {
  await failedPlaceholder('上游拒绝了这张图')

  expect(host.textContent).toContain('上游拒绝了这张图')
  expect(host.querySelector('button')).toBeNull()
})

it('占位所属的会话没打开时，不给「让助手重新处理」，免得这句话落进别的会话', async () => {
  agent.conversationId = 'conv-2'
  await failedPlaceholder('服务端写的那句话', 'invalid_params')

  expect(host.textContent).toContain('这次的参数不成立，没有提交')
  expect(host.querySelector('button')).toBeNull()

  // 切回占位所属的会话，出路就回来了。
  agent.conversationId = 'conv-1'
  act(() => root.render(<PlaceholderOverlay editor={editor} key="again" />))
  expect(host.querySelector('button')?.textContent).toBe('让助手重新处理')
})

it('结果未知的失败只说原因，不给出路', async () => {
  await failedPlaceholder('服务端写的那句话', 'result_unknown')

  expect(host.textContent).toContain('这次的结果没能确认')
  expect(host.querySelector('button')).toBeNull()
})

function cloudFailedPlaceholder(code: 'timeout') {
  const generationId = '70cf33ea-d548-4a2b-ab0b-4a10e2e444fb'
  const scene = projectScene(
    {
      version: 1,
      elements: [
        {
          id: `agent_${generationId}_0`,
          type: 'generation',
          generationId,
          position: 0,
          x: 0,
          y: 0,
          width: 360,
          height: 360,
          errorCode: code,
        },
      ],
    },
    new Map(),
    'conv-1',
  )
  editor.doc.restore(scene.elements, scene.files)
  act(() => root.render(<PlaceholderOverlay editor={editor} />))
}

/** 云端项目上提交就被拒：服务端没留位置，失败占位由本机补上。 */
async function cloudRefusedPlaceholder(
  code: 'insufficient_credits' | 'authentication_required' | 'model_unavailable',
) {
  const sink = createAgentCanvasSink(editor, undefined, {
    enabled: () => true,
    refresh: () => Promise.resolve(),
  })
  const ids = await sink.reserve({
    count: 1,
    messageId: 'tool-cloud',
    conversationId: 'conv-1',
    title: '一只橘猫',
  })
  sink.markFailed(ids, '服务端写的那句话', code)
  act(() => root.render(<PlaceholderOverlay editor={editor} />))
}

it('云端项目积分不够被拒：失败占位给去充值', async () => {
  await cloudRefusedPlaceholder('insufficient_credits')

  const button = host.querySelector('button')!
  expect(button.textContent).toBe('去充值')
  act(() => button.click())
  expect(notifyPrivateSubmissionError).toHaveBeenCalledWith({ insufficientCredits: true })
})

it('云端项目没登录被拒：失败占位叫出登录框', async () => {
  await cloudRefusedPlaceholder('authentication_required')

  const button = host.querySelector('button')!
  expect(button.textContent).toBe('去登录')
  const prompted = vi.fn()
  const unsubscribe = subscribeLoginPrompt(prompted)
  act(() => button.click())
  unsubscribe()
  // 弹登录框，不是把会话判失效——后者会把访客手上这张画布一起冲掉。
  expect(prompted.mock.calls).toEqual([['gated-action']])
})

it('云端项目模型不可用被拒：失败占位给让助手重新处理，发回项目的会话', async () => {
  await cloudRefusedPlaceholder('model_unavailable')

  const button = host.querySelector('button')!
  expect(button.textContent).toBe('让助手重新处理')
  act(() => button.click())
  expect(send).toHaveBeenCalledWith(expect.stringMatching(/^「一只橘猫」没有完成：/))
})

it('云端项目超时的失败占位只说原因', () => {
  cloudFailedPlaceholder('timeout')

  expect(host.querySelector('button')).toBeNull()
  expect(host.textContent).toContain('生成超时，这次没有出来')
})

describe('生成进度', () => {
  const NOW = Date.UTC(2026, 8, 18, 10, 0, 0)
  const card: AgentToolMessage = {
    kind: 'tool',
    id: 'tool-1',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    title: '一只橘猫',
    status: 'submitted',
    job: { taskId: '70cf33ea-d548-4a2b-ab0b-4a10e2e444fb', media: 'image' },
  }

  function progressText(container: HTMLElement): string {
    return container.querySelector('[role="progressbar"] p')?.textContent ?? ''
  }

  it('转圈的占位与对话里的结果卡说同一个阶段与已用时间', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] })
    agent.messages = [card]
    agent.jobProgress = { 'tool-1': { stage: 'submitted', submittedAt: NOW - 75_000 } }
    const sink = createAgentCanvasSink(editor)
    await sink.reserve({
      count: 1,
      messageId: 'tool-1',
      conversationId: 'conv-1',
      title: '一只橘猫',
    })
    act(() => root.render(<PlaceholderOverlay editor={editor} />))

    const cardHost = document.createElement('div')
    const cardRoot = createRoot(cardHost)
    try {
      act(() => cardRoot.render(<AgentToolCard message={card} />))
      expect(progressText(cardHost)).toBe('排队中 · 已用 1:15')
      expect(host.textContent).toContain('排队中 · 已用 1:15')

      // 服务端报任务开始生成：两处一起换阶段，时间一起走。
      agent.jobProgress = { 'tool-1': { stage: 'running', submittedAt: NOW - 75_000 } }
      act(() => vi.advanceTimersByTime(2_000))
      act(() => root.render(<PlaceholderOverlay editor={editor} key="again" />))
      act(() => cardRoot.render(<AgentToolCard message={{ ...card }} />))
      expect(progressText(cardHost)).toBe('生成中 · 已用 1:17')
      expect(host.textContent).toContain('生成中 · 已用 1:17')
    } finally {
      act(() => cardRoot.unmount())
    }
  })

  it('云端项目预留的占位按任务 id 认出结果卡', () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] })
    agent.messages = [card]
    agent.jobProgress = { 'tool-1': { stage: 'running', submittedAt: NOW - 3_000 } }
    const scene = projectScene(
      {
        version: 1,
        elements: [
          {
            id: projectArtifactId(card.job!.taskId, 0),
            type: 'generation',
            generationId: card.job!.taskId,
            position: 0,
            x: 0,
            y: 0,
            width: 360,
            height: 360,
          },
        ],
      },
      new Map(),
      'conv-1',
    )
    editor.doc.restore(scene.elements, scene.files)
    act(() => root.render(<PlaceholderOverlay editor={editor} />))
    expect(host.textContent).toContain('生成中 · 已用 0:03')
  })

  it('找不到对应的结果卡时照旧只说生成中', async () => {
    const sink = createAgentCanvasSink(editor)
    await sink.reserve({ count: 1, messageId: 'gone', conversationId: 'conv-1', title: '一只橘猫' })
    act(() => root.render(<PlaceholderOverlay editor={editor} />))
    expect(host.textContent).toContain('生成中')
    expect(host.textContent).not.toContain('已用')
  })
})

const RETRY_MODEL = 'gpt-image-2'

/** 原失败卡：生图、上游出错，起跑时记了快照、提交过后台任务。 */
function failedCard(overrides: Partial<AgentToolMessage> = {}): AgentToolMessage {
  return {
    kind: 'tool',
    id: 'tool-1',
    turnId: 'turn-1',
    toolCallId: 'call-1',
    toolName: 'generateImage',
    title: '一只橘猫',
    status: 'failed',
    errorCode: 'upstream_error',
    snapshot: {
      mode: 'image',
      args: { prompt: '一只橘猫', n: 2 },
      target: { provider: 'openai-compat', model: RETRY_MODEL },
    },
    job: { taskId: 'task-1', media: 'image' },
    ...overrides,
  }
}

function offerModels(...ids: string[]) {
  setChannels([
    {
      id: 'builtin',
      kind: 'openai-queue',
      label: 'Builtin',
      models: ids.map((id) => ({ id, label: id, capabilities: ['generate'] })),
      defaults: { apiMode: 'images', timeout: 600 },
    },
  ])
}

describe('单张重试', () => {
  it('上游出错的失败占位出现重试，写明预估积分，点击按原卡重试这一张', async () => {
    offerModels(RETRY_MODEL)
    agent.messages = [failedCard()]

    const [placeholderId] = await failedPlaceholder('服务端写的那句话', 'upstream_error')

    const button = host.querySelector('button')!
    expect(button.textContent).toContain('重试')
    expect(button.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('4')
    act(() => button.click())
    expect(agent.retry).toHaveBeenCalledWith('tool-1', placeholderId, undefined)
  })

  it('按钮一直按住到重试兑现（云端占位换成生成中之后），期间点不出第二次', async () => {
    offerModels(RETRY_MODEL)
    agent.messages = [failedCard()]
    let settle!: () => void
    agent.retry.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        }),
    )
    await failedPlaceholder('服务端写的那句话', 'upstream_error')

    const button = host.querySelector('button')!
    act(() => button.click())
    expect(button.disabled).toBe(true)
    act(() => button.click())
    expect(agent.retry).toHaveBeenCalledTimes(1)

    await act(async () => settle())
    expect(host.querySelector('button')?.disabled).toBe(false)
  })

  it.each(['timeout', 'no_output'] as const)('%s 同样可以重试', async (code) => {
    offerModels(RETRY_MODEL)
    agent.messages = [failedCard({ errorCode: code })]

    await failedPlaceholder('服务端写的那句话', code)

    expect(host.querySelector('button')?.textContent).toContain('重试')
  })

  it('视频按快照的时长与清晰度估积分', async () => {
    setChannels([
      {
        id: 'video',
        kind: 'openai-queue',
        label: 'Video',
        models: [{ id: 'veo-3', label: 'Veo', capabilities: ['generate'], media: 'video' }],
        defaults: { apiMode: 'images', timeout: 600 },
      },
    ])
    agent.messages = [
      failedCard({
        toolName: 'generateVideo',
        snapshot: {
          mode: 'video',
          args: { prompt: '猫跳起来' },
          target: { provider: 'openai-compat', model: 'veo-3' },
        },
        job: {
          taskId: 'task-1',
          media: 'video',
          video: { model: 'veo-3', duration: 8, aspectRatio: '16:9', resolution: '720p' },
        },
      }),
    ]

    await failedPlaceholder('服务端写的那句话', 'upstream_error')

    const credits = host.querySelector('button [role="img"]')!
    expect(credits.getAttribute('aria-label')).toContain('32')
  })

  // 这三种失败的码本来该给重试，资格却被否决了。原来两边都不命中，占位上一个按钮都没有——
  // 用户只看到一句原因，无路可走。现在改走「让助手重新处理」。
  it('模型已下线时不出现重试，改为让助手重新处理', async () => {
    offerModels('another-model')
    agent.messages = [failedCard()]

    await failedPlaceholder('服务端写的那句话', 'upstream_error')

    const button = host.querySelector('button')!
    expect(button.textContent).toBe('让助手重新处理')
    act(() => button.click())
    // 理由是真正的阻碍，不是错误码的译文：说「生成服务出错了」等于请它原样再来一次。
    expect(send).toHaveBeenCalledWith(
      '「一只橘猫」没有完成：当时用的那个模型已经不在可用清单里了。请换个做法重新处理。',
    )
  })

  it.each([
    ['局部改图', { selectionBindings: [{ imageId: 'img-1', selectionId: 'sel-1' }] }],
    ['分方案改图', { requestQuote: '把猫改成蓝色' }],
    ['连锁改图', { deferredEdits: [{ targetImageId: 'x', requestQuote: 'y' }] }],
  ])('%s不出现重试，改为让助手重新处理', async (_label, extra) => {
    offerModels(RETRY_MODEL)
    const card = failedCard({ toolName: 'editImage' })
    agent.messages = [
      { ...card, snapshot: { ...card.snapshot!, args: { ...card.snapshot!.args, ...extra } } },
    ]

    await failedPlaceholder('服务端写的那句话', 'upstream_error')

    expect(host.querySelector('button')?.textContent).toBe('让助手重新处理')
  })

  // 认不出是哪一次生成（旧失败没有参数快照、从没提交过后台任务）：既重出不了，也没法请
  // 智能体照着重新处理，只说原因。规格把这一类明确划在范围外（保持原样）。
  it('认不出是哪一次生成时什么按钮都不给', async () => {
    offerModels(RETRY_MODEL)
    agent.messages = [failedCard({ snapshot: undefined })]
    await failedPlaceholder('服务端写的那句话', 'upstream_error')
    expect(host.querySelector('button')).toBeNull()

    agent.messages = [failedCard({ job: undefined })]
    act(() => root.render(<PlaceholderOverlay editor={editor} key="again" />))
    expect(host.querySelector('button')).toBeNull()
  })

  it('一次重试因积分不够被拒后，占位按新的码给去充值而不是重试', async () => {
    offerModels(RETRY_MODEL)
    agent.messages = [failedCard()]

    await failedPlaceholder('', 'insufficient_credits')

    expect(host.querySelector('button')?.textContent).toBe('去充值')
  })

  it('占位所属的会话没打开时不出现重试', async () => {
    offerModels(RETRY_MODEL)
    agent.messages = [failedCard()]
    agent.conversationId = 'conv-2'

    await failedPlaceholder('服务端写的那句话', 'upstream_error')

    expect(host.querySelector('button')).toBeNull()
  })

  it('云端项目的失败占位凭任务 id 找到原卡，重试时交出它的元素 id', () => {
    offerModels(RETRY_MODEL)
    const generationId = '70cf33ea-d548-4a2b-ab0b-4a10e2e444fb'
    agent.messages = [
      failedCard({ errorCode: 'timeout', job: { taskId: generationId, media: 'image' } }),
    ]

    cloudFailedPlaceholder('timeout')

    const button = host.querySelector('button')!
    expect(button.textContent).toContain('重试')
    act(() => button.click())
    expect(agent.retry).toHaveBeenCalledWith('tool-1', `agent_${generationId}_0`, generationId)
  })

  it('云端项目的重试被拒（积分不够、没登录）：占位按拒绝的码给出路，不再出重试', () => {
    offerModels(RETRY_MODEL)
    const generationId = '70cf33ea-d548-4a2b-ab0b-4a10e2e444fb'
    agent.messages = [
      failedCard({ errorCode: 'timeout', job: { taskId: generationId, media: 'image' } }),
    ]
    agent.retryRefusals = {
      [`agent_${generationId}_0`]: { code: 'insufficient_credits', generationId },
    }

    cloudFailedPlaceholder('timeout')

    expect(host.querySelector('button')?.textContent).toBe('去充值')
    expect(host.textContent).not.toContain('重试')

    agent.retryRefusals = {
      [`agent_${generationId}_0`]: { code: 'authentication_required', generationId },
    }
    act(() => root.render(<PlaceholderOverlay editor={editor} key="again" />))
    expect(host.querySelector('button')?.textContent).toBe('去登录')
  })

  it('被拒那一层只对当时那次生成作数：占位被别处的重试换过之后照占位自己的码', () => {
    offerModels(RETRY_MODEL)
    const generationId = '70cf33ea-d548-4a2b-ab0b-4a10e2e444fb'
    agent.messages = [
      failedCard({ errorCode: 'timeout', job: { taskId: generationId, media: 'image' } }),
    ]
    agent.retryRefusals = {
      [`agent_${generationId}_0`]: { code: 'insufficient_credits', generationId: 'older-task' },
    }

    cloudFailedPlaceholder('timeout')

    expect(host.querySelector('button')?.textContent).toContain('重试')
  })

  it('云端项目里重试又失败：凭重试任务找到重试记录，再顺着它回到原卡', () => {
    offerModels(RETRY_MODEL)
    const generationId = '70cf33ea-d548-4a2b-ab0b-4a10e2e444fb'
    agent.messages = [
      failedCard({ errorCode: 'timeout' }),
      failedCard({
        id: 'retry-1',
        turnId: 'retry-turn',
        toolCallId: 'retry-call',
        errorCode: 'timeout',
        job: { taskId: generationId, media: 'image' },
        retryOf: { messageId: 'tool-1', toolCallId: 'call-1' },
      }),
    ]

    cloudFailedPlaceholder('timeout')

    act(() => host.querySelector('button')!.click())
    expect(agent.retry).toHaveBeenCalledWith('tool-1', `agent_${generationId}_0`, generationId)
  })
})

describe('重试排队', () => {
  /** 排在别的重试后面的那条重试记录：还没提交，没有任务。 */
  function queuedRecord(placeholderId: string, id = 'retry-1'): AgentToolMessage {
    return failedCard({
      id,
      turnId: `${id}-turn`,
      toolCallId: `${id}-call`,
      status: 'queued',
      errorCode: undefined,
      job: undefined,
      retryOf: { messageId: 'tool-1', toolCallId: 'call-1', placeholderId },
    })
  }

  it('排着的重试：占位标着排队中，只给撤回，不再给重试', async () => {
    offerModels(RETRY_MODEL)
    agent.messages = [failedCard()]
    const [placeholderId] = await failedPlaceholder('服务端写的那句话', 'upstream_error')
    agent.messages = [failedCard(), queuedRecord(placeholderId!)]

    act(() => root.render(<PlaceholderOverlay editor={editor} key="queued" />))

    expect(host.textContent).toContain('排队中')
    const buttons = [...host.querySelectorAll('button')]
    expect(buttons.map((button) => button.textContent)).toEqual(['撤回'])
    act(() => buttons[0]!.click())
    expect(agent.cancelJob).toHaveBeenCalledWith('retry-1')
    expect(agent.retry).not.toHaveBeenCalled()
  })

  it('撤回之后占位回到原来那次失败，又能重试', async () => {
    offerModels(RETRY_MODEL)
    const [placeholderId] = await failedPlaceholder('服务端写的那句话', 'upstream_error')
    agent.messages = [
      failedCard(),
      {
        ...queuedRecord(placeholderId!),
        status: 'failed',
        errorCode: 'cancelled',
      },
    ]

    act(() => root.render(<PlaceholderOverlay editor={editor} key="withdrawn" />))

    expect(host.textContent).not.toContain('排队中')
    expect(host.querySelector('button')?.textContent).toContain('重试')
  })

  it('结果卡上的重试记录：排着时说排队中、可以撤回；撤回之后说已撤回', () => {
    act(() => root.render(<AgentToolCard message={queuedRecord('placeholder-1')} />))
    expect(host.textContent).toContain('排队中')
    const withdraw = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === '撤回',
    )!
    act(() => withdraw.click())
    expect(agent.cancelJob).toHaveBeenCalledWith('retry-1')

    act(() =>
      root.render(
        <AgentToolCard
          message={{ ...queuedRecord('placeholder-1'), status: 'failed', errorCode: 'cancelled' }}
        />,
      ),
    )
    expect(host.textContent).toContain('重试已撤回')
    expect([...host.querySelectorAll('button')].map((button) => button.textContent)).not.toContain(
      '撤回',
    )
  })

  async function failedCall(count: number) {
    const sink = createAgentCanvasSink(editor)
    setAgentCanvasSink(sink)
    const ids = await sink.reserve({ count, messageId: 'tool-1', conversationId: 'conv-1' })
    sink.markFailed(ids, '', 'timeout')
    return ids
  }

  function retryRemainingButton() {
    return [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('重试剩下的'),
    )
  }

  it('失败卡一键补齐：数的是还没排着、没在跑的失败占位，点一下交给补齐', async () => {
    offerModels(RETRY_MODEL)
    const ids = await failedCall(3)
    const origin = failedCard({ errorCode: 'timeout' })
    agent.messages = [origin, queuedRecord(ids[2]!)]

    act(() => root.render(<AgentToolCard message={origin} />))

    const button = retryRemainingButton()!
    expect(button.textContent).toBe('重试剩下的 2 张')
    act(() => button.click())
    expect(agent.retryRemaining).toHaveBeenCalledWith('tool-1')
  })

  it('没有剩下可重试的失败占位、或原卡不能原样重试时不给补齐', async () => {
    offerModels(RETRY_MODEL)
    const ids = await failedCall(1)
    const origin = failedCard({ errorCode: 'timeout' })
    agent.messages = [origin, queuedRecord(ids[0]!)]
    act(() => root.render(<AgentToolCard message={origin} />))
    expect(retryRemainingButton()).toBeUndefined()

    offerModels('another-model')
    agent.messages = [origin]
    act(() => root.render(<AgentToolCard message={origin} key="gone" />))
    expect(retryRemainingButton()).toBeUndefined()
  })
})
