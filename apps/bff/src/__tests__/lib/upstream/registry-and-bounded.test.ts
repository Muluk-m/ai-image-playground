import { afterEach, describe, expect, it } from 'bun:test'
import {
  parseUpstreamResponse,
  readBoundedErrorText,
  UPSTREAM_ERROR_BODY_MAX_BYTES,
} from '../../../lib/upstream/bounded-error'
import {
  type ConcurrencyGate,
  InMemoryConcurrencyGate,
  setConcurrencyGateForTesting,
} from '../../../lib/upstream/concurrency'
import {
  defaultUpstreamRegistry,
  executeViaRoute,
  type UpstreamExecutor,
  UpstreamRegistry,
} from '../../../lib/upstream/executors/registry'
import type { UpstreamRoute } from '../../../lib/upstream/routes'
import { setUpstreamFetchForTesting } from '../../../lib/upstream/transport'
import type { UpstreamCallParams, UpstreamResponse } from '../../../lib/upstream/types'

afterEach(() => {
  setUpstreamFetchForTesting()
  setConcurrencyGateForTesting()
})

function baseRoute(overrides: Partial<UpstreamRoute> = {}): UpstreamRoute {
  return {
    baseUrl: 'https://upstream.example/v1',
    key: 'test-key',
    style: 'openai-images',
    forceB64Json: false,
    supportsModeration: true,
    asyncTasks: false,
    supportsNativeN: false,
    ...overrides,
  }
}

function baseParams(overrides: Partial<UpstreamCallParams> = {}): UpstreamCallParams {
  return {
    provider: 'openai-compat',
    model: 'gpt-image-1',
    request: { prompt: 'minimal white cup', n: 1 },
    ...overrides,
  }
}

describe('UpstreamRegistry', () => {
  it('routes video, openai-compat image, and gemini styles to dedicated default executors', () => {
    expect(
      defaultUpstreamRegistry.resolve({
        params: baseParams(),
        route: baseRoute({ style: 'ark-videos' }),
      })?.id,
    ).toBe('video')
    expect(
      defaultUpstreamRegistry.resolve({
        params: baseParams(),
        route: baseRoute({ style: 'veo-videos' }),
      })?.id,
    ).toBe('video')
    expect(
      defaultUpstreamRegistry.resolve({
        params: baseParams(),
        route: baseRoute({ style: 'openai-images' }),
      })?.id,
    ).toBe('openai-compat-image')
    expect(
      defaultUpstreamRegistry.resolve({
        params: baseParams(),
        route: baseRoute({ style: 'agnes-generations-json' }),
      })?.id,
    ).toBe('openai-compat-image')
    expect(
      defaultUpstreamRegistry.resolve({
        params: baseParams({ provider: 'gemini', model: 'gemini-3-pro-image' }),
        route: baseRoute({ style: 'vertex-generate-content' }),
      })?.id,
    ).toBe('gemini-image')
  })

  it('supports registering, overriding by id, and executing custom executors via executeViaRoute', async () => {
    const registry = new UpstreamRegistry(defaultUpstreamRegistry.list())
    const seen: string[] = []
    const custom: UpstreamExecutor = {
      id: 'openai-compat-image',
      matches({ params }) {
        return params.provider === 'openai-compat'
      },
      async execute(ctx) {
        seen.push(`${ctx.params.model}:${ctx.route.style}`)
        return { payload: { custom: true, prompt: ctx.request.prompt } }
      },
    }
    registry.register(custom)

    const result = await executeViaRoute(
      baseParams({ model: 'custom-model' }),
      baseRoute({ style: 'openai-images' }),
      {},
      { registry },
    )
    expect(result.payload).toEqual({ custom: true, prompt: 'minimal white cup' })
    expect(seen).toEqual(['custom-model:openai-images'])
  })
})

describe('ConcurrencyGate port', () => {
  it('enforces FIFO limits and cleans up idle gates on InMemoryConcurrencyGate', async () => {
    const gate = new InMemoryConcurrencyGate()
    const order: string[] = []
    const releaseFirst = await gate.acquire('vertex/test-model', 1)
    expect(gate.stateFor('vertex/test-model')).toEqual({ active: 1, waiting: 0 })

    const secondPromise = gate.acquire('vertex/test-model', 1).then((rel) => {
      order.push('second')
      return rel
    })
    expect(gate.stateFor('vertex/test-model')).toEqual({ active: 1, waiting: 1 })

    releaseFirst()
    const releaseSecond = await secondPromise
    expect(order).toEqual(['second'])
    releaseSecond()
    expect(gate.gateCount()).toBe(0)
  })

  it('injects custom ConcurrencyGate into geminiImageExecutor and releases on upstream error', async () => {
    const events: string[] = []
    const customGate: ConcurrencyGate = {
      async acquire(channelId, limit) {
        events.push(`acquire:${channelId}:${limit}`)
        return () => {
          events.push(`release:${channelId}`)
        }
      },
    }
    setUpstreamFetchForTesting(async () => ({
      ok: false,
      status: 500,
      body: null,
      text: async () => JSON.stringify({ error: { message: 'boom' } }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }))

    await expect(
      executeViaRoute(
        baseParams({ provider: 'gemini', model: 'gemini-3-pro-image' }),
        baseRoute({
          baseUrl: 'https://vertex.example/v1beta',
          style: 'vertex-generate-content',
          concurrency: { channelId: 'vertex-images/gemini-3-pro-image', limit: 2 },
        }),
        {},
        { concurrencyGate: customGate },
      ),
    ).rejects.toThrow('boom')

    expect(events).toEqual([
      'acquire:vertex-images/gemini-3-pro-image:2',
      'release:vertex-images/gemini-3-pro-image',
    ])
  })
})

describe('readBoundedErrorText and parseUpstreamResponse', () => {
  it('stops at the byte cap and cancels oversized non-2xx streams without pulling further chunks', async () => {
    let pulls = 0
    let cancelled = false
    const chunk = new Uint8Array(16 * 1024).fill(0x61) // 'a'
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls > 8) {
          controller.error(new Error('stream pulled far past safety cap'))
          return
        }
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    const res: UpstreamResponse = {
      ok: false,
      status: 502,
      body: stream,
      text: async () => {
        throw new Error('res.text() must not be called when body stream is present')
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    }

    const text = await readBoundedErrorText(res)
    expect(Buffer.byteLength(text)).toBe(UPSTREAM_ERROR_BODY_MAX_BYTES)
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThanOrEqual(5)
  })

  it('caps null-body non-2xx responses via text() fallback and exposes upstreamStatus/payload', async () => {
    const huge = 'x'.repeat(UPSTREAM_ERROR_BODY_MAX_BYTES + 1024)
    const res: UpstreamResponse = {
      ok: false,
      status: 503,
      body: null,
      text: async () => huge,
      arrayBuffer: async () => new ArrayBuffer(0),
    }

    let caught: (Error & { upstreamStatus?: number; upstreamPayload?: unknown }) | undefined
    try {
      await parseUpstreamResponse(res)
    } catch (err) {
      caught = err as Error & { upstreamStatus?: number; upstreamPayload?: unknown }
    }
    expect(caught?.upstreamStatus).toBe(503)
    expect(typeof caught?.upstreamPayload).toBe('string')
    expect((caught?.upstreamPayload as string).length).toBe(UPSTREAM_ERROR_BODY_MAX_BYTES)
  })
})
