import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type CallApiOptions, callImageApi, resumeQueueImageApi } from '../../lib/api'
import { DEFAULT_SETTINGS, normalizeSettings } from '../../lib/apiProfiles'
import type { BuiltinEdgeProfile, PublicChannel } from '../../lib/channels/types'
import { normalizeImageSize } from '../../lib/size'
import { type AppSettings, DEFAULT_PARAMS, type TaskParams } from '../../types'

/**
 * 分发层参数归一化的 wiring 测试：任何路径只要穿过 callImageApi / resumeQueueImageApi，
 * 到达队列适配器的 params 就必须是合法的。
 */

const adapters = vi.hoisted(() => ({
  queue: vi.fn(async (_opts: unknown) => ({ images: [] as string[] })),
  resumeQueue: vi.fn(async (_opts: unknown) => ({ images: [] as string[] })),
}))

vi.mock('../../lib/channels/queueClient', () => ({
  callQueueChannelApi: adapters.queue,
  resumeQueueChannelApi: adapters.resumeQueue,
  toQueueProvider: (kind: string) =>
    ({ 'openai-queue': 'openai-compat', 'gemini-queue': 'gemini' })[kind] ?? null,
}))
vi.mock('../../lib/canvasImage', () => ({
  createMaskPreviewDataUrl: vi.fn(async () => 'data:image/png;base64,YW5ub3RhdGVk'),
}))

const mockChannels = vi.hoisted(() => ({ list: [] as PublicChannel[] }))
vi.mock('../../lib/channels/publicChannels', () => ({
  getPublicChannels: () => mockChannels.list,
  getPublicChannel: (id: string) => mockChannels.list.find((c) => c.id === id),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockChannels.list = []
})

const QUEUE_CHANNEL: PublicChannel = {
  id: 'c-queue',
  kind: 'openai-queue',
  label: 'Queue',
  models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
  defaults: { apiMode: 'images', timeout: 600 },
}

const GEMINI_CHANNEL: PublicChannel = {
  id: 'c-gemini',
  kind: 'gemini-queue',
  label: 'Gemini',
  models: [
    {
      id: 'gemini-3.1-flash-image',
      label: 'Gemini',
      capabilities: ['generate', 'edit'],
    },
  ],
  defaults: { apiMode: 'images', timeout: 600 },
}

/** 把 channel 注册进 mock 列表，并返回选中它的 settings。 */
function useBuiltinChannel(channel: PublicChannel): AppSettings {
  const profile: BuiltinEdgeProfile = {
    id: `builtin-${channel.id}`,
    source: 'builtin-edge',
    channelId: channel.id,
    selectedModelId: channel.models[0].id,
  }
  mockChannels.list = [channel]
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    profiles: [profile],
    activeProfileId: profile.id,
  })
}

function baseOpts(settings: AppSettings, params: TaskParams): CallApiOptions {
  return { settings, prompt: '画一只猫', params, inputImageDataUrls: [] }
}

/** 漏斗最终交给适配器的 params。 */
function lastParams(adapter: (typeof adapters)[keyof typeof adapters]): TaskParams {
  return (adapter.mock.lastCall?.[0] as CallApiOptions).params
}

describe('dispatch-layer param enforcement', () => {
  it('normalizes count / transparent / size before the queue adapter', async () => {
    const settings = useBuiltinChannel(QUEUE_CHANNEL)
    const params = {
      ...DEFAULT_PARAMS,
      n: 12,
      output_format: 'jpeg' as const,
      transparent_output: true,
      size: '1000x1000',
    }

    await callImageApi(baseOpts(settings, params))

    const received = lastParams(adapters.queue)
    expect(received.n).toBe(10)
    expect(received.transparent_output).toBe(false)
    expect(received.size).toBe(normalizeImageSize('1000x1000'))
  })

  it('resets leftover transparent_output for gemini channels at dispatch', async () => {
    const settings = useBuiltinChannel(GEMINI_CHANNEL)
    const params = { ...DEFAULT_PARAMS, transparent_output: true }

    await callImageApi(baseOpts(settings, params))

    expect(lastParams(adapters.queue).transparent_output).toBe(false)
  })

  it('keeps legitimate transparent png params untouched (idempotent)', async () => {
    const settings = useBuiltinChannel(QUEUE_CHANNEL)
    const params = { ...DEFAULT_PARAMS, output_format: 'png' as const, transparent_output: true }

    await callImageApi(baseOpts(settings, params))

    const received = lastParams(adapters.queue)
    expect(received.transparent_output).toBe(true)
    expect(received.output_format).toBe('png')
  })

  it('normalizes on resumeQueueImageApi (canvas recover path)', async () => {
    const settings = useBuiltinChannel(QUEUE_CHANNEL)
    const params = {
      ...DEFAULT_PARAMS,
      output_format: 'jpeg' as const,
      transparent_output: true,
    }

    await resumeQueueImageApi(baseOpts(settings, params), 'req-1')

    expect(lastParams(adapters.resumeQueue).transparent_output).toBe(false)
  })
})
