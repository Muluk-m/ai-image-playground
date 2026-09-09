import { IMAGE_MIME_TYPES, MATTE_BACKEND, type MatteResponse } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { badRequestOnValidation, imageDataUrlSchema } from '../lib/http'
import { decodeDataUrl } from '../lib/imageArchive'
import { log } from '../lib/logger'
import {
  cachedForeground,
  MatteUpstreamError,
  segmentForeground,
  sourceContentType,
  verifySourceToken,
} from '../lib/matte'
import { objectStore } from '../lib/objectStore'
import { requireUserOrService } from '../lib/user-auth'

const matteBodySchema = t.Object({ image: imageDataUrlSchema() })

function matteResponse(png: Uint8Array, cached: boolean): MatteResponse {
  return {
    alpha: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
    backend: MATTE_BACKEND,
    cached,
  }
}

/** 每个实例要一份自己的：命名插件会被去重，两条路由就只剩一条挂上门禁。 */
const capabilityGate = () =>
  new Elysia().onBeforeHandle({ as: 'scoped' }, () => {
    if (!isCapabilityEnabled('matte:server')) return capabilityUnavailable('matte:server')
  })

// 抠图要花 Cloudflare 转换额度和对象存储，所以匿名请求不能进来。
const matteCreateRoutes = new Elysia()
  .use(badRequestOnValidation())
  .use(capabilityGate())
  .use(requireUserOrService)
  .get(
    '/api/matte/:hash',
    async ({ params, status, set }) => {
      set.headers['cache-control'] = 'private, no-store'
      const png = await cachedForeground(params.hash)
      return png ? matteResponse(png, true) : status(404, { error: 'not_found' })
    },
    { params: t.Object({ hash: t.String({ pattern: '^[0-9a-f]{64}$' }) }) },
  )
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
      return matteResponse(segmented.png, segmented.cached)
    },
    { body: matteBodySchema },
  )

// Cloudflare 回源取原图走这里，所以没有 cookie 鉴权，只认 token；单独一个实例才躲得开上面的鉴权。
const matteSourceRoutes = new Elysia()
  .use(capabilityGate())
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

export const matteRoutes = new Elysia().use(matteCreateRoutes).use(matteSourceRoutes)
