import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestServerMatte } from '../../lib/matteClient'
import { _setRuntimeConfigForTesting } from '../../lib/runtimeConfig'

const MATTE = {
  alpha: 'data:image/png;base64,AAA',
  backend: 'cloudflare-birefnet',
  cached: false,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'https://bff.example.com/' } })
})

afterEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: false, baseUrl: '' } })
  vi.restoreAllMocks()
})

describe('asking the BFF to matte the product', () => {
  it('posts the image and returns the alpha', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(MATTE))

    const result = await requestServerMatte('data:image/png;base64,SRC', fetcher)

    expect(fetcher).toHaveBeenCalledWith(
      'https://bff.example.com/api/matte',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      image: 'data:image/png;base64,SRC',
    })
    expect(result).toEqual(MATTE)
  })

  it('throws when the route turns the image down', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: 'too-large' }, 413))

    await expect(requestServerMatte('data:image/png;base64,SRC', fetcher)).rejects.toThrow(
      '服务端抠图没有返回可用的蒙版',
    )
  })

  it('throws when the body is not a matte', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ alpha: 'not-a-data-url' }))

    await expect(requestServerMatte('data:image/png;base64,SRC', fetcher)).rejects.toThrow(
      '服务端抠图没有返回可用的蒙版',
    )
  })
})
