import { createHash } from 'node:crypto'
import { MATTE_BACKEND, MATTE_MAX_IMAGE_BYTES, type MatteResponse } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { decodeDataUrl } from '../lib/imageArchive'
import { log } from '../lib/logger'
import { fetchForegroundPng, mintSourceToken, verifySourceToken } from '../lib/matte'
import { objectStore } from '../lib/objectStore'

const SOURCE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}
const SOURCE_MIMES: Record<string, string> = Object.fromEntries(
  Object.entries(SOURCE_EXTENSIONS).map(([mime, extension]) => [extension, mime]),
)

const matteBodySchema = t.Object({
  image: t.String({ pattern: '^data:image/', maxLength: MATTE_MAX_IMAGE_BYTES }),
})

function matteResponse(alpha: Uint8Array, cached: boolean): MatteResponse {
  return {
    alpha: `data:image/png;base64,${Buffer.from(alpha).toString('base64')}`,
    backend: MATTE_BACKEND,
    cached,
  }
}

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
      const extension = SOURCE_EXTENSIONS[decoded.mime.toLowerCase()]
      if (!extension) {
        return status(400, { error: 'invalid_request', message: `unsupported ${decoded.mime}` })
      }

      const hash = createHash('sha256').update(decoded.bytes).digest('hex')
      const store = objectStore()
      const alphaKey = `matte/${hash}/alpha.png`
      if ((await store.listPrefix(`matte/${hash}/`)).includes(alphaKey)) {
        return matteResponse(await store.read(alphaKey), true)
      }

      const sourceKey = `matte/${hash}/source.${extension}`
      await store.write(sourceKey, decoded.bytes, decoded.mime)
      let alpha: Uint8Array
      try {
        alpha = await fetchForegroundPng(mintSourceToken(sourceKey))
      } catch (error) {
        // 只记 message：cause 里带着签好 token 的取图 URL。
        const message = error instanceof Error ? error.message : String(error)
        log.warn({ event: 'matte.upstream_failed', message }, 'foreground segmentation failed')
        return status(502, { error: 'matte_upstream_error' })
      }
      await store.write(alphaKey, alpha, 'image/png')
      return matteResponse(alpha, false)
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
        'content-type': SOURCE_MIMES[key.slice(key.lastIndexOf('.') + 1)] ?? 'image/png',
        'cache-control': 'private, max-age=300',
      },
    })
  })
