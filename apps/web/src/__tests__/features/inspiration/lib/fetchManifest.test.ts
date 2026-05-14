import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchRemoteManifest } from '../../../../features/inspiration/lib/fetchManifest'

const goodManifest = {
  version: 1,
  updatedAt: '2026-05-12T00:00:00Z',
  items: [
    {
      id: 'a',
      title: 'A',
      prompt: 'p',
      thumbnailUrl: 'https://x/a.jpg',
      params: { size: '1024x1024' },
      recommendedModel: 'gpt-image-2',
      recommendedProvider: 'openai-compat',
      category: '头像',
    },
  ],
  categories: ['头像'],
}

function mockFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal('fetch', vi.fn(impl))
}

describe('fetchRemoteManifest', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses a valid manifest', async () => {
    mockFetch(() => Promise.resolve(new Response(JSON.stringify(goodManifest), { status: 200 })))
    const m = await fetchRemoteManifest('https://x/manifest.json')
    expect(m.version).toBe(1)
    expect(m.items).toHaveLength(1)
    expect(m.items[0].id).toBe('a')
  })

  it('throws on HTTP error', async () => {
    mockFetch(() => Promise.resolve(new Response('not found', { status: 404 })))
    await expect(fetchRemoteManifest('https://x/manifest.json')).rejects.toThrow(/HTTP 404/)
  })

  it('throws on non-JSON body', async () => {
    mockFetch(() => Promise.resolve(new Response('<html>oops</html>', { status: 200 })))
    await expect(fetchRemoteManifest('https://x/manifest.json')).rejects.toThrow(/非 JSON/)
  })

  it('throws on structurally invalid manifest', async () => {
    mockFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ version: 'oops' }), { status: 200 })),
    )
    await expect(fetchRemoteManifest('https://x/manifest.json')).rejects.toThrow(/结构无效/)
  })

  it('drops items with missing required fields but keeps the manifest', async () => {
    const mixedManifest = {
      ...goodManifest,
      items: [
        goodManifest.items[0],
        { id: 'bad' }, // missing required fields
      ],
    }
    mockFetch(() => Promise.resolve(new Response(JSON.stringify(mixedManifest), { status: 200 })))
    const m = await fetchRemoteManifest('https://x/manifest.json')
    expect(m.items).toHaveLength(1)
    expect(m.items[0].id).toBe('a')
  })
})
