import { Elysia, t } from 'elysia'
import {
  isAllowedListingImageUrl,
  parseAmazonListingUrl,
  parseListingPage,
} from '../lib/amazonListing'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { fetchListingHtml, fetchListingImage } from '../lib/listingFetch'
import { log } from '../lib/logger'

export const remixListingRoutes = new Elysia()
  .onError({ as: 'scoped' }, ({ code, error, set }) => {
    if (code === 'VALIDATION') {
      set.status = 400
      return { error: 'invalid_request', message: error.message }
    }
  })
  .post(
    '/api/remix/listing',
    async ({ body, status }) => {
      if (!isCapabilityEnabled('remix:listing')) return capabilityUnavailable('remix:listing')

      const listing = parseAmazonListingUrl(body.url)
      if (!listing) return status(400, { error: 'unsupported_listing_url' })

      let page: ReturnType<typeof parseListingPage>
      try {
        page = parseListingPage(await fetchListingHtml(listing.canonicalUrl))
      } catch (error) {
        log.warn(
          { event: 'remix.listing_fetch_failed', asin: listing.asin, err: error },
          'listing fetch failed',
        )
        return status(502, { error: 'listing_unavailable' })
      }
      // 空图集意味着验证码页或页面结构变了，两者前端都只能回落到上传。
      if (page.images.length === 0) return status(502, { error: 'listing_unavailable' })

      return { asin: listing.asin, ...page }
    },
    { body: t.Object({ url: t.String({ minLength: 1, maxLength: 2048 }) }) },
  )
  .get(
    '/api/remix/image',
    async ({ query, status }) => {
      if (!isCapabilityEnabled('remix:listing')) return capabilityUnavailable('remix:listing')
      if (!isAllowedListingImageUrl(query.url))
        return status(400, { error: 'image_host_not_allowed' })

      try {
        const image = await fetchListingImage(query.url)
        return new Response(image.body, {
          headers: {
            'content-type': image.contentType,
            'cache-control': 'private, max-age=3600',
          },
        })
      } catch (error) {
        log.warn(
          { event: 'remix.image_fetch_failed', url: query.url, err: error },
          'listing image fetch failed',
        )
        return status(502, { error: 'image_unavailable' })
      }
    },
    { query: t.Object({ url: t.String({ minLength: 1, maxLength: 2048 }) }) },
  )
