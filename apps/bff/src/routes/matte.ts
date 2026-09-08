import {
  IMAGE_MIME_TYPES,
  MATTE_BACKEND,
  MATTE_MAX_IMAGE_BYTES,
  type MatteResponse,
} from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { decodeDataUrl } from '../lib/imageArchive'
import { log } from '../lib/logger'
import {
  MatteUpstreamError,
  segmentForeground,
  sourceContentType,
  verifySourceToken,
} from '../lib/matte'
import { objectStore } from '../lib/objectStore'

const matteBodySchema = t.Object({
  image: t.String({ pattern: '^data:image/', maxLength: MATTE_MAX_IMAGE_BYTES }),
})

export const matteRoutes = new Elysia()
  // Elysia 默认对 body schema 校验失败返 422；规范要求 400，统一在路由作用域拦截。
  .onError({ as: 'scoped' }, ({ code, error, set }) => {
    if (code === 'VALIDATION') {
      set.status = 400
      return { error: 'invalid_request', message: error.message }
    }
  })
  .onBeforeHandle(() => {
    if (!isCapabilityEnabled('matte:server')) return capabilityUnavailable('matte:server')
  })
  .post(
    '/api/matte',
    async ({ body, status }) => {
      let decoded: { bytes: Uint8Array; mime: string }
      try {
        decoded = decodeDataUrl(body.image)
      } catch {
        return status(400, { error: 'invalid_request', message: 'image must be a base64 data URL' })
      }
      const mime = decoded.mime.toLowerCase()
      if (!(IMAGE_MIME_TYPES as readonly string[]).includes(mime)) {
        return status(400, { error: 'invalid_request', message: `unsupported ${decoded.mime}` })
      }

      let segmented: { png: Uint8Array; cached: boolean }
      try {
        segmented = await segmentForeground(decoded.bytes, mime)
      } catch (error) {
        if (!(error instanceof MatteUpstreamError)) throw error
        // 只记 message：cause 里带着签好 token 的取图 URL。
        log.warn(
          { event: 'matte.upstream_failed', message: error.message },
          'foreground segmentation failed',
        )
        return status(502, { error: 'matte_upstream_error' })
      }
      return {
        alpha: `data:image/png;base64,${Buffer.from(segmented.png).toString('base64')}`,
        backend: MATTE_BACKEND,
        cached: segmented.cached,
      } satisfies MatteResponse
    },
    { body: matteBodySchema },
  )
  // Cloudflare 回源取原图走这里，所以没有 cookie 鉴权，只认 token。
  .get('/api/matte/source/:token', async ({ params, status }) => {
    const key = verifySourceToken(params.token)
    if (!key) return status(404, { error: 'not_found' })

    let bytes: Uint8Array<ArrayBuffer>
    try {
      bytes = await objectStore().read(key)
    } catch {
      return status(404, { error: 'not_found' })
    }
    return new Response(bytes, {
      headers: {
        'content-type': sourceContentType(key),
        'cache-control': 'private, max-age=300',
      },
    })
  })
