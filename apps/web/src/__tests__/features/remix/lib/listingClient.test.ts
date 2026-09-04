import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchListingImages,
  listingImageProxyUrl,
} from '../../../../features/remix/lib/listingClient'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

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

describe('fetching a competitor listing', () => {
  it('posts the url to the BFF and returns the image list', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        asin: 'B0FVLNS696',
        title: 'Abruzzo Bathtub',
        images: ['https://m.media-amazon.com/images/I/a.jpg'],
      }),
    )

    const listing = await fetchListingImages('https://www.amazon.com/dp/B0FVLNS696', fetcher)

    expect(fetcher).toHaveBeenCalledWith(
      'https://bff.example.com/api/remix/listing',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      url: 'https://www.amazon.com/dp/B0FVLNS696',
    })
    expect(listing).toEqual({
      asin: 'B0FVLNS696',
      title: 'Abruzzo Bathtub',
      images: ['https://m.media-amazon.com/images/I/a.jpg'],
    })
  })

  it('reports an unreachable listing so the caller can fall back to uploading', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ error: 'listing_unavailable' }, 502))

    await expect(
      fetchListingImages('https://www.amazon.com/dp/B0FVLNS696', fetcher),
    ).rejects.toThrow('抓不到这条链接的图集')
  })

  it('rejects a response whose images are not a list of urls', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ asin: 'B0', images: 'nope' }))

    await expect(fetchListingImages('https://www.amazon.com/dp/B0', fetcher)).rejects.toThrow()
  })

  it('routes image bytes through the BFF proxy', () => {
    expect(listingImageProxyUrl('https://m.media-amazon.com/images/I/a.jpg?x=1')).toBe(
      'https://bff.example.com/api/remix/image?url=https%3A%2F%2Fm.media-amazon.com%2Fimages%2FI%2Fa.jpg%3Fx%3D1',
    )
  })
})
