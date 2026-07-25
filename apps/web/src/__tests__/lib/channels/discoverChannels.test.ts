import type { ChannelDiscoveryResponse } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import { fetchDiscoveredChannels } from '../../../lib/channels/discoverChannels'

const SAMPLE: ChannelDiscoveryResponse = {
  channels: [
    {
      id: 'sample-openai',
      kind: 'openai-queue',
      label: 'Sample OpenAI',
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate', 'edit'] }],
      defaults: { apiMode: 'images', codexCli: true, timeout: 600 },
    },
  ],
}

function mockFetch(
  status: number,
  body: unknown,
  opts: { rawText?: string; rejectWith?: Error } = {},
): (input: string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    if (opts.rejectWith) throw opts.rejectWith
    void input
    void init
    return new Response(opts.rawText ?? JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

describe('fetchDiscoveredChannels', () => {
  it('returns parsed channels on 200 + valid envelope', async () => {
    const channels = await fetchDiscoveredChannels('https://bff.example.com', {
      fetcher: mockFetch(200, SAMPLE),
    })
    expect(channels).toHaveLength(1)
    expect(channels[0].id).toBe('sample-openai')
  })

  it('targets <base>/api/channels and strips trailing slash from base', async () => {
    let captured: string | undefined
    const fetcher = async (input: string) => {
      captured = input
      return new Response(JSON.stringify(SAMPLE), { status: 200 })
    }
    await fetchDiscoveredChannels('https://bff.example.com//', { fetcher })
    expect(captured).toBe('https://bff.example.com/api/channels')
  })

  it('uses relative path when base is empty (same-origin)', async () => {
    let captured: string | undefined
    const fetcher = async (input: string) => {
      captured = input
      return new Response(JSON.stringify(SAMPLE), { status: 200 })
    }
    await fetchDiscoveredChannels('', { fetcher })
    expect(captured).toBe('/api/channels')
  })

  it('forwards AbortSignal to fetcher', async () => {
    let capturedSignal: AbortSignal | undefined
    const fetcher = async (_input: string, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined
      return new Response(JSON.stringify(SAMPLE), { status: 200 })
    }
    const signal = AbortSignal.timeout(1000)
    await fetchDiscoveredChannels('', { fetcher, signal })
    expect(capturedSignal).toBe(signal)
  })

  it('includes session cookies in channel discovery', async () => {
    let captured: RequestInit | undefined
    const fetcher = async (_input: string, init?: RequestInit) => {
      captured = init
      return new Response(JSON.stringify(SAMPLE), { status: 200 })
    }
    await fetchDiscoveredChannels('', { fetcher })
    expect(captured?.credentials).toBe('include')
  })

  it('throws on non-2xx', async () => {
    await expect(
      fetchDiscoveredChannels('https://bff.example.com', { fetcher: mockFetch(500, '') }),
    ).rejects.toThrow(/500/)
  })

  it('throws on missing channels array', async () => {
    await expect(
      fetchDiscoveredChannels('https://bff.example.com', {
        fetcher: mockFetch(200, { oops: true }),
      }),
    ).rejects.toThrow(/channels/)
  })

  it('propagates network rejection', async () => {
    await expect(
      fetchDiscoveredChannels('https://bff.example.com', {
        fetcher: mockFetch(0, null, { rejectWith: new Error('offline') }),
      }),
    ).rejects.toThrow(/offline/)
  })
})
