import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type CallApiOptions, callImageApi, resumeQueueImageApi } from '../../lib/api'
import { DEFAULT_SETTINGS, normalizeSettings } from '../../lib/apiProfiles'
import type { BuiltinEdgeProfile, PublicChannel } from '../../lib/channels/types'
import { normalizeImageSize } from '../../lib/size'
import { type AppSettings, DEFAULT_PARAMS, type TaskParams } from '../../types'

/**
 * 分发层参数归一化的 wiring 测试：任何路径（工作台 / canvas / 恢复 / 重试）只要穿过
 * callImageApi / resumeQueueImageApi 这个漏斗，到达 adapter 的 params 就必须是合法的。
 * adapter 全部 mock，断言的是「漏斗交出去的参数」，不是 adapter 行为。
 */

const adapters = vi.hoisted(() => ({
  openai: vi.fn(async (_opts: unknown) => ({ images: [] as string[] })),
  gemini: vi.fn(async (_opts: unknown) => ({ images: [] as string[] })),
  queue: vi.fn(async (_opts: unknown) => ({ images: [] as string[] })),
  resumeQueue: vi.fn(async (_opts: unknown) => ({ images: [] as string[] })),
}))

vi.mock('../../lib/openaiCompatibleImageApi', () => ({
  callOpenAICompatibleImageApi: adapters.openai,
}))
vi.mock('../../lib/geminiImageApi', () => ({
  callGeminiImageApi: adapters.gemini,
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

function byokSettings(kind: 'openai-compat' | 'gemini'): AppSettings {
  return normalizeSettings({
    ...DEFAULT_SETTINGS,
    profiles: [
      {
        id: 'p1',
        source: 'user-byok',
        name: kind,
        kind,
        baseUrl: 'https://x.test/v1',
        apiKey: 'k',
      },
    ],
    activeProfileId: 'p1',
  })
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

/** 漏斗最终交给 adapter 的 params —— 本文件所有断言的取值口。 */
function lastParams(adapter: (typeof adapters)[keyof typeof adapters]): TaskParams {
  return (adapter.mock.lastCall?.[0] as CallApiOptions).params
}

describe('dispatch-layer param enforcement', () => {
  it('normalizes count / transparent / size before the byok adapter', async () => {
    const settings = byokSettings('openai-compat')
    const params = {
      ...DEFAULT_PARAMS,
      n: 12,
      output_format: 'jpeg' as const,
      transparent_output: true,
      size: '1000x1000',
    }

    await callImageApi(baseOpts(settings, params))

    const received = lastParams(adapters.openai)
    expect(received.n).toBe(10)
    expect(received.transparent_output).toBe(false)
    expect(received.size).toBe(normalizeImageSize('1000x1000'))
  })

  it('resets leftover transparent_output for gemini profiles at dispatch', async () => {
    const settings = byokSettings('gemini')
    const params = { ...DEFAULT_PARAMS, transparent_output: true }

    await callImageApi(baseOpts(settings, params))

    expect(lastParams(adapters.gemini).transparent_output).toBe(false)
  })

  it('keeps legitimate transparent png params untouched (idempotent)', async () => {
    const settings = byokSettings('openai-compat')
    const params = { ...DEFAULT_PARAMS, output_format: 'png' as const, transparent_output: true }

    await callImageApi(baseOpts(settings, params))

    const received = lastParams(adapters.openai)
    expect(received.transparent_output).toBe(true)
    expect(received.output_format).toBe('png')
  })

  it('normalizes before the builtin-edge queue adapter', async () => {
    const settings = useBuiltinChannel(QUEUE_CHANNEL)
    const params = { ...DEFAULT_PARAMS, n: 12 }

    await callImageApi(baseOpts(settings, params))

    expect(lastParams(adapters.queue).n).toBe(10)
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
