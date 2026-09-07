import {
  SYNC_ASSET_IMAGE_MIME_TYPES,
  SYNC_ID_MAX_LENGTH,
  SYNC_IMAGE_ID_PATTERN,
  SYNC_MAX_CHANGES_PER_COLLECTION,
  SYNC_NAME_MAX_LENGTH,
  SYNC_PROMPT_MAX_LENGTH,
  SYNC_SETTINGS_MAX_BYTES,
  SYNC_TEMPLATE_ASSET_IDS_MAX,
  SYNC_TEMPLATE_PARAMS_MAX_BYTES,
} from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { synchronize } from '../lib/sync'
import { readAssetImage, storeAssetImage } from '../lib/sync-assets'
import { resolveAuthUser } from '../lib/user-auth'

const epochMs = t.Integer({ minimum: 0 })
const syncId = t.String({ minLength: 1, maxLength: SYNC_ID_MAX_LENGTH })

const tombstoneSchema = t.Object({
  id: syncId,
  updatedAt: epochMs,
  deletedAt: epochMs,
})

const templateSchema = t.Object({
  id: syncId,
  name: t.String({ maxLength: SYNC_NAME_MAX_LENGTH }),
  prompt: t.String({ maxLength: SYNC_PROMPT_MAX_LENGTH }),
  assetIds: t.Array(t.Union([syncId, t.Null()]), { maxItems: SYNC_TEMPLATE_ASSET_IDS_MAX }),
  params: t.Record(t.String(), t.Unknown()),
  createdAt: epochMs,
  updatedAt: epochMs,
  lastUsedAt: epochMs,
})

const assetSchema = t.Object({
  id: syncId,
  name: t.String({ maxLength: SYNC_NAME_MAX_LENGTH }),
  imageId: syncId,
  createdAt: epochMs,
  updatedAt: epochMs,
  lastUsedAt: epochMs,
})

function overBudget(value: unknown, limit: number): boolean {
  return Buffer.byteLength(JSON.stringify(value)) > limit
}

// 这两个 union 会让 exact-mirror 打 "TypeCompiler is required" 警告（elysia 1.4 的上游缺陷）；
// 拆掉 union 就没人再挡「半条记录」，警告留着。
const syncBodySchema = t.Object({
  version: t.Integer({ minimum: 0 }),
  templates: t.Optional(
    t.Array(t.Union([tombstoneSchema, templateSchema]), {
      maxItems: SYNC_MAX_CHANGES_PER_COLLECTION,
    }),
  ),
  assets: t.Optional(
    t.Array(t.Union([tombstoneSchema, assetSchema]), {
      maxItems: SYNC_MAX_CHANGES_PER_COLLECTION,
    }),
  ),
  settings: t.Optional(
    t.Nullable(
      t.Object({
        updatedAt: epochMs,
        document: t.Record(t.String(), t.Unknown()),
      }),
    ),
  ),
})

const imageIdParams = t.Object({
  imageId: t.String({ minLength: 1, maxLength: SYNC_ID_MAX_LENGTH }),
})

function isAssetImageMime(value: string): boolean {
  return (SYNC_ASSET_IMAGE_MIME_TYPES as readonly string[]).includes(value)
}

export const syncRoutes = new Elysia()
  // Elysia 默认对 body schema 校验失败返 422；规范要求 400，统一在路由作用域拦截。
  .onError({ as: 'scoped' }, ({ code, error, set }) => {
    if (code === 'VALIDATION') {
      set.status = 400
      return { error: 'invalid_request', message: error.message }
    }
  })
  .use(resolveAuthUser)
  // 能力关闭时连身份都不该泄露，所以 404 排在 401 前面。
  .onBeforeHandle(() => {
    if (!isCapabilityEnabled('accounts:sync')) return capabilityUnavailable('accounts:sync')
  })
  .post(
    '/api/sync',
    async ({ authUser, body, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      if (body.settings && overBudget(body.settings.document, SYNC_SETTINGS_MAX_BYTES)) {
        return status(400, { error: 'invalid_request', message: 'settings document too large' })
      }
      // jsonb 列没有长度上限，params 的字节数只能在这里挡。
      if (
        body.templates?.some(
          (change) =>
            'params' in change && overBudget(change.params, SYNC_TEMPLATE_PARAMS_MAX_BYTES),
        )
      ) {
        return status(400, { error: 'invalid_request', message: 'template params too large' })
      }
      return synchronize(authUser.id, body)
    },
    { body: syncBodySchema },
  )
  .put(
    '/api/sync/assets/:imageId',
    async ({ authUser, params, request, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      if (!SYNC_IMAGE_ID_PATTERN.test(params.imageId)) {
        return status(400, { error: 'invalid_request', message: 'malformed imageId' })
      }
      const contentType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim()
      if (!isAssetImageMime(contentType)) return status(415, { error: 'unsupported_media_type' })

      const bytes = new Uint8Array(await request.arrayBuffer())
      const stored = await storeAssetImage(authUser.id, params.imageId, bytes, contentType)
      if (!stored.ok) return status(413, { error: stored.error, limit: stored.limit })
      return { imageId: stored.imageId, bytes: stored.bytes, totalBytes: stored.totalBytes }
    },
    { params: imageIdParams, parse: 'none' },
  )
  .get(
    '/api/sync/assets/:imageId',
    async ({ authUser, params, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      const stored = SYNC_IMAGE_ID_PATTERN.test(params.imageId)
        ? await readAssetImage(authUser.id, params.imageId)
        : null
      if (!stored) return status(404, { error: 'asset_image_not_found' })
      return new Response(stored.bytes, {
        headers: {
          'content-type': stored.contentType,
          'cache-control': 'private, max-age=31536000, immutable',
        },
      })
    },
    { params: imageIdParams },
  )
