// @vitest-environment jsdom
import type { AgentBackgroundJobProgress } from '@image-playground/shared'
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentToolCard from '../../../../features/agent/components/AgentToolCard'
import { rememberVideoOutputFrame } from '../../../../features/agent/lib/artifactSource'
import type { AgentToolMessage } from '../../../../features/agent/types'
import { setChannels } from '../../../../lib/channels/channelStore'

const fixtures = vi.hoisted(() => ({
  state: {
    messages: [] as AgentToolMessage[],
    jobProgress: {} as Record<string, AgentBackgroundJobProgress>,
    toolStartedAt: {},
    promptDrafts: {},
    retry: vi.fn(async () => true),
    cancelJob: vi.fn(async () => {}),
    send: vi.fn(),
    confirmPrompt: vi.fn(),
    setPromptDraft: vi.fn(),
    placeOnCanvas: vi.fn(async () => {}),
  },
  canvasAvailable: false,
  has: vi.fn(() => false),
  thumbnail: vi.fn(async () => null),
  fetch: vi.fn(),
  download: vi.fn(),
}))
vi.mock('../../../../features/agent/store', () => ({
  useAgentStore: Object.assign(
    (select: (state: typeof fixtures.state) => unknown) => select(fixtures.state),
    { getState: () => fixtures.state },
  ),
}))
vi.mock('../../../../lib/privateOverlay', () => ({
  usePrivateSubmissionGuard: () => ({ blocked: false, estimatedCredits: 80 }),
  notifyPrivateSubmissionError: vi.fn(),
}))
vi.mock('../../../../features/agent/lib/canvasSink', () => ({
  agentCanvasSink: () =>
    fixtures.canvasAvailable ? { has: fixtures.has, thumbnail: fixtures.thumbnail } : null,
}))
vi.mock('../../../../lib/authClient', () => ({ authenticatedBffFetch: fixtures.fetch }))
vi.mock('../../../../lib/downloadImages', () => ({ downloadBlob: fixtures.download }))
vi.mock('../../../../lib/clientCapabilities', () => ({ isClientCapabilityEnabled: () => true }))
const frames = vi.hoisted(() => ({
  cachedVideoOutputFrame: vi.fn(
    (_output: { taskId: string; outputIndex: number }): Promise<string | null> | undefined =>
      Promise.resolve(null),
  ),
}))
vi.mock('../../../../features/agent/lib/artifactSource', () => ({
  cachedVideoOutputFrame: frames.cachedVideoOutputFrame,
  rememberVideoOutputFrame: vi.fn(),
}))

vi.mock('../../../../features/video/lib/playback', () => ({
  captureVideoFrame: () => 'data:image/jpeg;base64,DECODED',
}))

const model = 'grok-imagine-video'
const record = { model, duration: 8, resolution: '720p' as const, aspectRatio: '9:16' as const }
const base: AgentToolMessage = {
  kind: 'tool',
  id: 'video-card',
  turnId: 'turn',
  toolCallId: 'call',
  toolName: 'generateVideo',
  title: '海浪视频',
  prompt: '海浪缓慢涌来',
  status: 'submitted',
  job: { taskId: 'video-task', media: 'video', video: record },
  snapshot: { mode: 'image', args: {}, target: { provider: 'openai-compat', model } },
}
let host: HTMLDivElement
let root: Root
globalThis.IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  frames.cachedVideoOutputFrame.mockReset()
  frames.cachedVideoOutputFrame.mockResolvedValue(null)
  fixtures.canvasAvailable = false
  fixtures.has.mockReturnValue(false)
  fixtures.state.messages = []
  fixtures.state.jobProgress = {
    [base.id]: { stage: 'running', phase: 'generating', submittedAt: Date.now() - 42_000 },
  }
  setChannels([
    {
      id: 'video',
      kind: 'openai-queue',
      label: 'Video',
      models: [{ id: model, label: 'Grok', media: 'video', capabilities: ['generate'] }],
      defaults: {},
    },
  ])
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  setChannels([])
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
async function render(message: AgentToolMessage) {
  await act(async () => root.render(<AgentToolCard message={message} onPreviewResult={vi.fn()} />))
}
function button(text: string) {
  return [...host.querySelectorAll('button')].find((node) =>
    (node.getAttribute('aria-label') ?? node.textContent)?.includes(text),
  )!
}

it('shows video parameters and estimated cost before confirmation', async () => {
  await render({ ...base, status: 'awaiting_confirmation', video: record, job: undefined })
  expect(host.textContent).toContain('Grok')
  expect(host.textContent).toContain('8 秒')
  expect(host.textContent).toContain('9:16')
  expect(host.textContent).toContain('预估消耗')
  expect(host.querySelector('textarea')?.value).toBe(base.prompt)
  expect(fixtures.state.confirmPrompt).not.toHaveBeenCalled()
})

it('uses a video waiting surface, server progress and an independent cancel action', async () => {
  await render(base)
  expect(host.querySelector('[data-slot="video-generation"]')).not.toBeNull()
  expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext')).toContain(
    '0:42',
  )
  expect(host.querySelector('video')).toBeNull()
  const card = host.querySelector<HTMLElement>('[data-slot="agent-video-card"]')!
  expect(card.style.width).toBe('100%')
  expect(host.querySelector<HTMLElement>('[data-slot="video-generation"]')!.className).toContain(
    'aspect-video',
  )
  expect(host.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false)
  for (const label of ['取消', '查看提示词']) expect(button(label).className).toContain('size-8')
  await act(async () => button('取消').click())
  expect(fixtures.state.cancelJob).toHaveBeenCalledWith(base.id)
})

it('plays recovered video results inline without waiting for a canvas or a poster', async () => {
  await render({
    ...base,
    status: 'succeeded',
    artifacts: [
      {
        artifactId: 'clip',
        media: 'video',
        taskId: 'video-task',
        outputIndex: 0,
        mime: 'video/mp4',
        video: record,
      },
    ],
  })
  const video = host.querySelector('video')!
  const player = host.querySelector<HTMLElement>('[data-slot="video-player"]')!
  expect(video.getAttribute('src')).toContain('/video-task/output/0')
  expect(video.controls).toBe(true)
  expect(video.autoplay).toBe(false)
  expect(video.preload).toBe('metadata')
  expect(video.crossOrigin).toBe('use-credentials')
  expect(video.getAttribute('poster')).toBeNull()
  expect(player.style.aspectRatio).toBe('9 / 16')
  expect(player.style.maxHeight).toBe('min(24rem, 46vh)')
  expect(host.querySelector<HTMLElement>('[data-slot="agent-video-card"]')!.style.width).toContain(
    '24rem',
  )
  expect(host.querySelector('[data-slot="video-generation"]')).toBeNull()
  await act(async () => video.dispatchEvent(new Event('error')))
  expect(host.textContent).toContain('视频暂时无法播放')
  await act(async () => button('重新加载').click())
  expect(host.querySelector('video')).not.toBe(video)
  expect(fixtures.state.retry).not.toHaveBeenCalled()
})

it('fills the frame-sized player with the captured first frame once it arrives', async () => {
  let settle: (frame: string | null) => void = () => {}
  frames.cachedVideoOutputFrame.mockReturnValue(
    new Promise((resolve) => {
      settle = resolve
    }),
  )
  await render({
    ...base,
    status: 'succeeded',
    artifacts: [
      {
        artifactId: 'clip',
        media: 'video',
        taskId: 'video-task',
        outputIndex: 0,
        mime: 'video/mp4',
        video: record,
      },
    ],
  })
  expect(host.querySelector('video')!.getAttribute('poster')).toBeNull()
  expect(frames.cachedVideoOutputFrame).toHaveBeenCalledWith(
    expect.objectContaining({ taskId: 'video-task', outputIndex: 0 }),
  )
  await act(async () => {
    settle('data:image/jpeg;base64,FRAME')
  })
  expect(host.querySelector('video')!.getAttribute('poster')).toBe('data:image/jpeg;base64,FRAME')
  expect(host.querySelector('video')!.preload).toBe('metadata')
})

it('downloads authenticated video bytes instead of saving the poster as a PNG', async () => {
  fixtures.fetch.mockResolvedValue(
    new Response('video-bytes', { headers: { 'content-type': 'video/mp4' } }),
  )
  await render({
    ...base,
    status: 'succeeded',
    artifacts: [
      {
        artifactId: 'clip',
        media: 'video',
        taskId: 'video-task',
        outputIndex: 0,
        mime: 'video/mp4',
      },
    ],
  })
  await act(async () => button('下载').click())
  expect(fixtures.fetch).toHaveBeenCalledWith(expect.stringContaining('/video-task/output/0'))
  expect(fixtures.download).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'video/mp4', size: 11 }),
    'muvloom-clip.mp4',
  )
})

it('does not download a login/error HTML document as a video', async () => {
  fixtures.fetch.mockResolvedValue(
    new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }),
  )
  await render({
    ...base,
    status: 'succeeded',
    artifacts: [
      {
        artifactId: 'clip',
        media: 'video',
        taskId: 'video-task',
        outputIndex: 0,
        mime: 'video/mp4',
      },
    ],
  })
  await act(async () => button('下载').click())
  expect(fixtures.download).not.toHaveBeenCalled()
  expect(host.textContent).toContain('视频下载失败')
})

it('keeps the task title and cancellation receipt when a video is cancelled', async () => {
  await render({ ...base, status: 'failed', errorCode: 'cancelled' })
  expect(host.textContent).toContain(base.title)
  expect(host.querySelector('[data-slot="stopped-run"]')).not.toBeNull()
  expect(host.querySelector('[data-slot="tool-error"]')).toBeNull()
  expect(fixtures.state.retry).not.toHaveBeenCalled()
})

it('retries a failed video directly without a canvas placeholder and deduplicates clicks', async () => {
  await render({ ...base, status: 'failed', errorCode: 'upstream_error' })
  const retry = button('重试视频生成')
  await act(async () => {
    retry.click()
    retry.click()
  })
  expect(fixtures.state.retry).toHaveBeenCalledTimes(1)
  expect(fixtures.state.retry).toHaveBeenCalledWith(base.id)
  expect(fixtures.state.send).not.toHaveBeenCalled()
})

it('does not offer another retry when a retry is already queued', async () => {
  fixtures.state.messages = [
    {
      ...base,
      id: 'retry',
      status: 'queued',
      retryOf: { messageId: base.id, toolCallId: base.toolCallId },
    },
  ]
  await render({ ...base, status: 'failed', errorCode: 'upstream_error' })
  expect(button('重试视频生成')).toBeUndefined()
})

it('allows a queued retry to be withdrawn', async () => {
  await render({
    ...base,
    job: undefined,
    status: 'queued',
    retryOf: { messageId: 'original', toolCallId: 'original-call' },
  })
  await act(async () => button('撤回').click())
  expect(fixtures.state.cancelJob).toHaveBeenCalledWith(base.id)
})

it.each([
  'failed',
  'placed',
] as const)('restores a %s delivery to the canvas without generating or charging again', async (delivery) => {
  fixtures.canvasAvailable = true
  const message: AgentToolMessage = {
    ...base,
    status: 'succeeded',
    delivery,
    artifacts: [
      {
        artifactId: 'clip',
        media: 'video',
        taskId: 'video-task',
        outputIndex: 0,
        mime: 'video/mp4',
      },
    ],
  }
  await act(async () => root.render(<AgentToolCard message={message} />))
  expect(host.querySelector('video')).not.toBeNull()
  expect(host.textContent).toContain(
    delivery === 'failed' ? '产物已生成，但载入失败' : '产物不在当前画布上',
  )
  await act(async () => {
    button('放入画布').click()
    button('放入画布').click()
  })
  expect(fixtures.state.placeOnCanvas).toHaveBeenCalledExactlyOnceWith(base.id)
  expect(fixtures.state.retry).not.toHaveBeenCalled()
  expect(fixtures.state.confirmPrompt).not.toHaveBeenCalled()
})

it('keeps canvas recovery out of Chat video results', async () => {
  fixtures.canvasAvailable = true
  await render({
    ...base,
    status: 'succeeded',
    delivery: 'failed',
    artifacts: [
      {
        artifactId: 'clip',
        media: 'video',
        taskId: 'video-task',
        outputIndex: 0,
        mime: 'video/mp4',
      },
    ],
  })
  expect(button('放入画布')).toBeUndefined()
  expect(host.textContent).not.toContain('载入失败')
  expect(host.querySelector('video')).not.toBeNull()
})

it.each([
  'failed',
  'unavailable',
  'placed',
] as const)('opens the canvas only after confirmed placement, not a resolved %s outcome', async (delivery) => {
  fixtures.canvasAvailable = true
  const message: AgentToolMessage = {
    ...base,
    status: 'succeeded',
    delivery: 'failed',
    artifacts: [
      {
        artifactId: 'clip',
        media: 'video',
        taskId: 'video-task',
        outputIndex: 0,
        mime: 'video/mp4',
      },
    ],
  }
  const view = vi.fn()
  fixtures.state.placeOnCanvas.mockImplementationOnce(async () => {
    fixtures.state.messages = [{ ...message, delivery }]
  })
  await act(async () => root.render(<AgentToolCard message={message} onViewCanvas={view} />))
  await act(async () => button('放入画布').click())
  expect(view).toHaveBeenCalledTimes(delivery === 'placed' ? 1 : 0)
  expect(fixtures.state.retry).not.toHaveBeenCalled()
})

it('preloads only nearby video results, then shares the first decoded frame without another stream', async () => {
  let intersect: (entries: { isIntersecting: boolean }[]) => void = () => {}
  const disconnect = vi.fn()
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: typeof intersect) {
        intersect = callback
      }
      observe = vi.fn()
      disconnect = disconnect
    },
  )
  frames.cachedVideoOutputFrame.mockReturnValue(undefined)
  fixtures.canvasAvailable = true
  fixtures.has.mockReturnValue(true)
  await render({
    ...base,
    status: 'succeeded',
    artifacts: [
      {
        artifactId: 'visible-clip',
        media: 'video',
        taskId: 'video-task',
        outputIndex: 0,
        mime: 'video/mp4',
        video: record,
      },
    ],
  })
  const video = host.querySelector('video')!
  expect(video.preload).toBe('none')
  expect(video.getAttribute('src')).toBeNull()
  expect(host.querySelector('[role="status"]')).toBeNull()
  await act(async () => intersect([{ isIntersecting: false }]))
  expect(video.preload).toBe('none')
  await act(async () => intersect([{ isIntersecting: true }]))
  expect(video.preload).toBe('metadata')
  expect(video.autoplay).toBe(false)
  expect(host.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('加载视频')
  expect(disconnect).not.toHaveBeenCalled()
  await act(async () => intersect([{ isIntersecting: false }]))
  expect(video.getAttribute('src')).toBeNull()
  await act(async () => intersect([{ isIntersecting: true }]))
  expect(video.getAttribute('src')).toContain('/video-task/output/0')
  await act(async () => video.dispatchEvent(new Event('loadeddata')))
  expect(host.querySelector('[role="status"]')).toBeNull()
  expect(rememberVideoOutputFrame).toHaveBeenCalledWith(
    expect.objectContaining({ taskId: 'video-task', outputIndex: 0 }),
    'data:image/jpeg;base64,DECODED',
  )
  expect(video.poster).toBe('data:image/jpeg;base64,DECODED')
  await act(async () => video.dispatchEvent(new Event('waiting')))
  expect(host.querySelector('[role="status"]')).toBeNull()
  const paused = vi.spyOn(video, 'paused', 'get').mockReturnValue(false)
  await act(async () => video.dispatchEvent(new Event('play')))
  expect(video.preload).toBe('auto')
  await act(async () => video.dispatchEvent(new Event('waiting')))
  expect(host.querySelector('[role="status"]')?.className).toBe('sr-only')
  await act(async () => video.dispatchEvent(new Event('playing')))
  expect(host.querySelector('[role="status"]')).toBeNull()
  await act(async () => intersect([{ isIntersecting: false }]))
  expect(video.getAttribute('src')).toContain('/video-task/output/0')
  expect(video.preload).toBe('auto')
  Object.defineProperty(video, 'readyState', { configurable: true, value: 4 })
  Object.defineProperty(video, 'duration', { configurable: true, value: 8 })
  video.currentTime = 3
  await act(async () => video.dispatchEvent(new Event('timeupdate')))
  paused.mockReturnValue(true)
  await act(async () => video.dispatchEvent(new Event('pause')))
  expect(video.getAttribute('src')).toBeNull()
  video.currentTime = 0
  await act(async () => video.dispatchEvent(new Event('timeupdate')))
  expect(HTMLMediaElement.prototype.load).toHaveBeenCalled()
  expect(host.querySelector('[role="status"]')).toBeNull()
  await act(async () => intersect([{ isIntersecting: true }]))
  expect(video.getAttribute('src')).toContain('/video-task/output/0')
  expect(video.preload).toBe('metadata')
  expect(video.poster).toBe('data:image/jpeg;base64,DECODED')
  await act(async () => video.dispatchEvent(new Event('loadedmetadata')))
  expect(video.currentTime).toBe(3)
  expect(fixtures.fetch).not.toHaveBeenCalled()
  expect(fixtures.thumbnail).not.toHaveBeenCalled()
})

it('shows video settings and download as labelled icons with meaningful values', async () => {
  await render({
    ...base,
    status: 'succeeded',
    video: { ...record, firstFrameId: 'first', lastFrameId: 'last', referenceIds: ['ref'] },
    artifacts: [
      {
        artifactId: 'clip',
        media: 'video',
        taskId: 'video-task',
        outputIndex: 0,
        mime: 'video/mp4',
      },
    ],
  })
  const details = host.querySelector('[aria-label="视频参数"]')!
  expect(details.querySelector('[aria-label="8 秒"] svg')).not.toBeNull()
  expect(details.querySelector('[aria-label="清晰度 720p"] svg')).not.toBeNull()
  expect(details.querySelector('[aria-label="比例 9:16"] svg')).not.toBeNull()
  expect(details.querySelector('[aria-label="首帧"] svg')).not.toBeNull()
  expect(details.querySelector('[aria-label="尾帧"] svg')).not.toBeNull()
  expect(details.querySelector('[aria-label="1 张参考图"] svg')).not.toBeNull()
  expect(details.textContent).not.toContain('首帧')
  expect(button('下载').querySelector('svg')).not.toBeNull()
  expect(button('下载').querySelector('.sr-only')?.textContent).toBe('下载')
  expect(button('下载').getAttribute('aria-label')).toBe('下载')
})

it('preserves a playable source across StrictMode effect replay and releases it on removal', async () => {
  const message: AgentToolMessage = {
    ...base,
    status: 'succeeded',
    artifacts: [
      {
        artifactId: 'strict-clip',
        media: 'video',
        taskId: 'video-task',
        outputIndex: 0,
        mime: 'video/mp4',
        video: record,
      },
    ],
  }
  await act(async () =>
    root.render(
      <StrictMode>
        <AgentToolCard message={message} onPreviewResult={vi.fn()} />
      </StrictMode>,
    ),
  )
  const video = host.querySelector('video')!
  expect(video.getAttribute('src')).toContain('/video-task/output/0')
  await act(async () => root.render(null))
  expect(video.getAttribute('src')).toBeNull()
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled()
})

it('bounds recovered portrait results by their decoded dimensions without a second spinner', async () => {
  await render({
    ...base,
    status: 'succeeded',
    artifacts: [
      {
        artifactId: 'actual-portrait',
        media: 'video',
        taskId: 'portrait-task',
        outputIndex: 0,
        mime: 'video/mp4',
        video: { ...record, aspectRatio: '16:9' },
      },
    ],
  })
  const video = host.querySelector('video')!
  const card = host.querySelector<HTMLElement>('[data-slot="agent-video-card"]')!
  const player = host.querySelector<HTMLElement>('[data-slot="video-player"]')!
  expect(card.style.width).not.toBe('100%')
  expect(player.style.maxHeight).toBe('min(24rem, 46vh)')
  expect(host.querySelector('[role="status"] svg')).toBeNull()
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: 768 })
  Object.defineProperty(video, 'videoHeight', { configurable: true, value: 1168 })
  await act(async () => video.dispatchEvent(new Event('loadedmetadata')))
  expect(player.style.aspectRatio).toBe('768 / 1168')
  expect(card.style.width).toContain(String(768 / 1168))
  await act(async () => video.dispatchEvent(new Event('loadeddata')))
  await act(async () => video.dispatchEvent(new Event('waiting')))
  expect(host.querySelector('[role="status"]')).toBeNull()
})

it('offers media reload after a bounded load timeout without repeating generation', async () => {
  vi.useFakeTimers()
  try {
    await render({
      ...base,
      status: 'succeeded',
      artifacts: [
        {
          artifactId: 'slow',
          media: 'video',
          taskId: 'slow-task',
          outputIndex: 0,
          mime: 'video/mp4',
        },
      ],
    })
    await act(async () => vi.advanceTimersByTime(45_000))
    expect(host.textContent).toContain('视频暂时无法播放')
    await act(async () => button('重新加载').click())
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(fixtures.state.retry).not.toHaveBeenCalled()
    await act(async () => host.querySelector('video')!.dispatchEvent(new Event('loadeddata')))
    await act(async () => vi.advanceTimersByTime(45_000))
    expect(host.querySelector('[role="alert"]')).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

it('keeps metadata-only previews playable while still timing out an actual playback stall', async () => {
  vi.useFakeTimers()
  try {
    await render({
      ...base,
      status: 'succeeded',
      artifacts: [
        {
          artifactId: 'metadata-only',
          media: 'video',
          taskId: 'metadata-task',
          outputIndex: 0,
          mime: 'video/mp4',
        },
      ],
    })
    const video = host.querySelector('video')!
    Object.defineProperty(video, 'readyState', { configurable: true, value: 1 })
    await act(async () => video.dispatchEvent(new Event('loadedmetadata')))
    await act(async () => vi.advanceTimersByTime(45_000))
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector('[role="status"]')).toBeNull()
    await act(async () => video.dispatchEvent(new Event('play')))
    expect(video.preload).toBe('auto')
    await act(async () => vi.advanceTimersByTime(45_000))
    expect(host.textContent).toContain('视频暂时无法播放')
    expect(fixtures.state.retry).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
