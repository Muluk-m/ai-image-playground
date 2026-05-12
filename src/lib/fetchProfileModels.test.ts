import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultGeminiProfile, createDefaultOpenAIProfile } from './apiProfiles'
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
    const profile = createDefaultOpenAIProfile({ apiKey: 'k', baseUrl: '   ' })
    await expect(fetchProfileModels(profile)).rejects.toThrow(/API URL/)
  })

  it('rejects when apiKey is empty', async () => {
    const profile = createDefaultOpenAIProfile({ apiKey: '', baseUrl: 'https://x.example/v1' })
    await expect(fetchProfileModels(profile)).rejects.toThrow(/API Key/)
  })

  it('GETs {baseUrl}/models with Bearer auth for openai provider', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ id: 'gpt-image-2' }, { id: 'gpt-image-2-2026-04-21' }],
    }), { status: 200 }))

    const profile = createDefaultOpenAIProfile({ apiKey: 'sk-x', baseUrl: 'https://x.example/v1' })
    const result = await fetchProfileModels(profile)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://x.example/v1/models')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-x')
    expect(result).toEqual(['gpt-image-2', 'gpt-image-2-2026-04-21'])
  })

  it('GETs with x-api-key header for gemini provider, strips models/ prefix', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      models: [
        { name: 'models/gemini-3.1-flash-image' },
        { name: 'models/gemini-3.1-pro-preview' },
      ],
    }), { status: 200 }))

    const profile = createDefaultGeminiProfile({ apiKey: 'gk', baseUrl: 'https://gen.example/v1beta' })
    const result = await fetchProfileModels(profile)

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

    const profile = createDefaultOpenAIProfile({ apiKey: 'bad', baseUrl: 'https://x.example/v1' })
    await expect(fetchProfileModels(profile)).rejects.toThrow(/Unauthorized/)
  })

  it('throws when response contains no recognizable model list', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const profile = createDefaultOpenAIProfile({ apiKey: 'k', baseUrl: 'https://x.example/v1' })
    await expect(fetchProfileModels(profile)).rejects.toThrow(/未找到/)
  })
})
