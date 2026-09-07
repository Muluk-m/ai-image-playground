import {
  SYNC_ID_MAX_LENGTH,
  SYNC_MAX_CHANGES_PER_COLLECTION,
  SYNC_NAME_MAX_LENGTH,
  SYNC_PROMPT_MAX_LENGTH,
  SYNC_SETTINGS_MAX_BYTES,
  SYNC_TEMPLATE_ASSET_IDS_MAX,
} from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { synchronize } from '../lib/sync'
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
      if (
        body.settings &&
        Buffer.byteLength(JSON.stringify(body.settings.document)) > SYNC_SETTINGS_MAX_BYTES
      ) {
        return status(400, { error: 'invalid_request', message: 'settings document too large' })
      }
      return synchronize(authUser.id, body)
    },
    { body: syncBodySchema },
  )
