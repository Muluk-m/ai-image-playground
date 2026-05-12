import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchProfileModels } from './fetchProfileModels'

describe('fetchProfileModels', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })
  afterEach(() => {
    fetchMock.mockReset()
  })

  it('rejects when baseUrl is empty', async () => {
    await expect(fetchProfileModels({ baseUrl: '   ', apiKey: 'k', kind: 'openai-compat' })).rejects.toThrow(/API URL/)
  })

  it('rejects when apiKey is empty', async () => {
    await expect(fetchProfileModels({ baseUrl: 'https://x.example/v1', apiKey: '', kind: 'openai-compat' })).rejects.toThrow(/API Key/)
  })

  it('GETs {baseUrl}/models with Bearer auth for openai-compat kind', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ id: 'gpt-image-2' }, { id: 'gpt-image-2-2026-04-21' }],
    }), { status: 200 }))

    const result = await fetchProfileModels({ baseUrl: 'https://x.example/v1', apiKey: 'sk-x', kind: 'openai-compat' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://x.example/v1/models')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-x')
    expect(result).toEqual(['gpt-image-2', 'gpt-image-2-2026-04-21'])
  })

  it('GETs with x-api-key header for gemini kind, strips models/ prefix', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      models: [
        { name: 'models/gemini-3.1-flash-image' },
        { name: 'models/gemini-3.1-pro-preview' },
      ],
    }), { status: 200 }))

    const result = await fetchProfileModels({ baseUrl: 'https://gen.example/v1beta', apiKey: 'gk', kind: 'gemini' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://gen.example/v1beta/models')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['x-api-key']).toBe('gk')
    expect(result).toEqual(['gemini-3.1-flash-image', 'gemini-3.1-pro-preview'])
  })

  it('throws with API error message on HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { message: 'Unauthorized', code: 401 },
    }), { status: 401 }))

    await expect(fetchProfileModels({ baseUrl: 'https://x.example/v1', apiKey: 'bad', kind: 'openai-compat' })).rejects.toThrow(/Unauthorized/)
  })

  it('throws when response contains no recognizable model list', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await expect(fetchProfileModels({ baseUrl: 'https://x.example/v1', apiKey: 'k', kind: 'openai-compat' })).rejects.toThrow(/未找到/)
  })
})
