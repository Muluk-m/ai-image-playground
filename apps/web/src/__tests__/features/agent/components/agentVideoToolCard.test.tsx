// @vitest-environment jsdom
import type { AgentBackgroundJobProgress } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AgentToolCard from '../../../../features/agent/components/AgentToolCard'
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
  },
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
vi.mock('../../../../lib/authClient', () => ({ authenticatedBffFetch: fixtures.fetch }))
vi.mock('../../../../lib/downloadImages', () => ({ downloadBlob: fixtures.download }))
vi.mock('../../../../lib/clientCapabilities', () => ({ isClientCapabilityEnabled: () => true }))

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
})
async function render(message: AgentToolMessage) {
  await act(async () => root.render(<AgentToolCard message={message} onPreviewResult={vi.fn()} />))
}
function button(text: string) {
  return [...host.querySelectorAll('button')].find((node) => node.textContent?.includes(text))!
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
  expect(video.getAttribute('src')).toContain('/video-task/output/0')
  expect(video.controls).toBe(true)
  expect(video.autoplay).toBe(false)
  expect(video.preload).toBe('none')
  expect(host.querySelector('[data-slot="video-generation"]')).toBeNull()
  await act(async () => video.dispatchEvent(new Event('error')))
  expect(host.textContent).toContain('视频暂时无法播放')
  await act(async () => button('重新加载').click())
  expect(host.querySelector('video')).not.toBe(video)
  expect(fixtures.state.retry).not.toHaveBeenCalled()
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
