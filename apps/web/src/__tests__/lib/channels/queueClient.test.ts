import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callQueueChannelApi } from '../../../lib/channels/queueClient'
import type { BuiltinEdgeProfile, PublicChannel } from '../../../lib/channels/types'

const STORAGE_KEY = 'image-playground.device_id'

/**
 * Vitest 默认跑在 node env，无 DOM。手动塞个最小 localStorage shim，
 * 行为对齐 Web Storage（同步、错误时抛）。
 */
function makeLocalStorageShim(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key: string) {
      return store.has(key) ? (store.get(key) ?? null) : null
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null
    },
    removeItem(key: string) {
      store.delete(key)
    },
    setItem(key: string, value: string) {
      store.set(key, value)
    },
  }
}

function mockChannel(): PublicChannel {
  return {
    id: 'test-queue',
    kind: 'openai-queue',
    label: 'test',
    bffBaseUrl: 'https://bff.example.com',
    provider: 'openai-compat',
    models: [{ id: 'gpt-image-1', label: 'GPT Image 1' }],
    defaultModel: 'gpt-image-1',
    defaults: {},
  } as unknown as PublicChannel
}

function mockProfile(): BuiltinEdgeProfile {
  return { selectedModelId: 'gpt-image-1' } as unknown as BuiltinEdgeProfile
}

function mockOpts() {
  return {
    prompt: 'a cat',
    params: { size: 'auto', quality: 'auto', n: 1 },
    inputImageDataUrls: [],
    maskDataUrl: undefined,
    clientRequestId: 'req-aaaa-bbbb-cccc',
  } as unknown as Parameters<typeof callQueueChannelApi>[0]
}

describe('callQueueChannelApi submit body', () => {
  beforeEach(() => {
    const shim = makeLocalStorageShim()
    vi.stubGlobal('localStorage', shim)
    localStorage.setItem(STORAGE_KEY, 'dev-aaaa-bbbb-cccc')
    vi.resetModules()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('submit body 包含 device_id 字段', async () => {
    const { callQueueChannelApi: call } = await import('../../../lib/channels/queueClient')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    // 第 1 次请求：submit OK
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ request_id: 'rid-1', status: 'queued' }), { status: 200 }),
    )
    // 第 2 次请求（poll status）：直接 failed，让 callQueueChannelApi 立刻抛
    // 异常退出，不必等 30 分钟 POLL_MAX_MS 超时。
    fetchSpy.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            request_id: 'rid-1',
            status: 'failed',
            submitted_at: Date.now(),
            error: { message: 'test-stop', type: 'unknown' },
          }),
          { status: 200 },
        ),
    )

    await expect(call(mockOpts(), mockProfile(), mockChannel())).rejects.toThrow('test-stop')

    // 第一次请求即 submit，验证 body 含 device_id
    const firstCall = fetchSpy.mock.calls[0]!
    expect(String(firstCall[0])).toContain('/v1/queue/openai-compat/gpt-image-1/submit')
    const body = JSON.parse(String((firstCall[1] as RequestInit).body))
    expect(body.device_id).toBe('dev-aaaa-bbbb-cccc')
  })

  it('429 daily_quota_exceeded 抛中文错误且 quotaExceeded=true', async () => {
    const { callQueueChannelApi: call } = await import('../../../lib/channels/queueClient')
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: 'daily_quota_exceeded',
            limit: 50,
            used: 50,
            reset_at: '2026-05-16T00:00:00.000Z',
          }),
          { status: 429 },
        ),
    )

    try {
      await call(mockOpts(), mockProfile(), mockChannel())
      throw new Error('did not throw')
    } catch (err) {
      const e = err as Error & { quotaExceeded?: boolean; resetAt?: string }
      expect(e.message).toContain('今日 80 张已用完')
      expect(e.quotaExceeded).toBe(true)
      expect(e.resetAt).toBe('2026-05-16T00:00:00.000Z')
    }
  })
})
