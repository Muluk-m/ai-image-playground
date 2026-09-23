import {
  assembleLookRequest,
  type LookAssemblyAsset,
  SYNC_ID_MAX_LENGTH,
} from '@image-playground/shared'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { db, schema } from '../db/client'
import { ensureAgentSkills, findAgentSkill, readAgentSkillFileBytes } from '../lib/agent/skills'
import { capabilityUnavailable, isCapabilityEnabled } from '../lib/capabilities'
import { resolveQueueModel } from '../lib/channels'
import { deviceIdSchema } from '../lib/http'
import { reservationFailureResponse } from '../lib/private-overlay'
import { readAssetImage } from '../lib/sync-assets'
import { createQueueTask } from '../lib/taskSubmission'
import { resolveAuthUser } from '../lib/user-auth'

/** 一批最多几条素材。上限存在是为了挡住一次点掉整个素材库，不是产品刻度。 */
export const LOOK_BATCH_MAX_ASSETS = 20
/** 每条素材最多出几张。 */
export const LOOK_BATCH_MAX_PER_ASSET = 4

const batchBodySchema = t.Object({
  lookId: t.Optional(t.String({ minLength: 1, maxLength: SYNC_ID_MAX_LENGTH })),
  skillName: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  assetIds: t.Array(t.String({ minLength: 1, maxLength: SYNC_ID_MAX_LENGTH }), {
    minItems: 1,
    maxItems: LOOK_BATCH_MAX_ASSETS,
  }),
  // `t.Integer` 会被编译成字符串/整数的联合转换，exact-mirror 镜不出来，启动就刷一屏告警。
  perAsset: t.Number({ minimum: 1, maximum: LOOK_BATCH_MAX_PER_ASSET, multipleOf: 1 }),
  /**
   * 某条素材要出几张，盖过 `perAsset`。只在素材位是一个（每条素材各起一个任务）时有意义：
   * 素材位不止一个时整批只有一个任务，张数由 `perAsset` 定。
   */
  counts: t.Optional(
    t.Record(
      t.String({ minLength: 1, maxLength: SYNC_ID_MAX_LENGTH }),
      t.Number({ minimum: 1, maximum: LOOK_BATCH_MAX_PER_ASSET, multipleOf: 1 }),
    ),
  ),
  device_id: deviceIdSchema(),
})

/**
 * 出图要用到的模板那几项。自建模板来自 `user_looks`，预置模板来自技能目录里带模板标记的技能；
 * 两者的差别只剩参考图从哪儿读——`skillName` 在场时参考图 id 是技能目录里的文件名。
 */
interface BatchLook {
  readonly body: string
  readonly slotCount: number
  readonly model: string
  readonly size: string
  readonly referenceImageIds: readonly string[]
  readonly skillName?: string
}

async function readUserLook(userId: string, lookId: string): Promise<BatchLook | null> {
  const [row] = await db
    .select({
      body: schema.user_looks.body,
      slotCount: schema.user_looks.slot_count,
      model: schema.user_looks.model,
      size: schema.user_looks.size,
      referenceImageIds: schema.user_looks.reference_image_ids,
    })
    .from(schema.user_looks)
    .where(
      and(
        eq(schema.user_looks.user_id, userId),
        eq(schema.user_looks.id, lookId),
        isNull(schema.user_looks.deleted_at),
      ),
    )
    .limit(1)
  if (!row?.body) return null
  return {
    body: row.body,
    slotCount: row.slotCount ?? 1,
    model: row.model ?? '',
    size: row.size ?? '',
    referenceImageIds: row.referenceImageIds ?? [],
  }
}

async function readBuiltinLook(skillName: string): Promise<BatchLook | null> {
  await ensureAgentSkills()
  const skill = findAgentSkill('image', skillName)
  if (!skill?.template) return null
  return {
    body: skill.content,
    slotCount: skill.template.slotCount,
    model: skill.template.model,
    size: skill.template.size,
    referenceImageIds: skill.template.references,
    skillName: skill.name,
  }
}

/** 旧素材没有 `views`，封面就是它唯一的一张视角。 */
async function readAssets(
  userId: string,
  assetIds: readonly string[],
): Promise<Map<string, LookAssemblyAsset>> {
  const rows = await db
    .select({
      id: schema.user_assets.id,
      name: schema.user_assets.name,
      imageId: schema.user_assets.image_id,
      views: schema.user_assets.views,
    })
    .from(schema.user_assets)
    .where(
      and(
        eq(schema.user_assets.user_id, userId),
        inArray(schema.user_assets.id, [...assetIds]),
        isNull(schema.user_assets.deleted_at),
      ),
    )
  const assets = new Map<string, LookAssemblyAsset>()
  for (const row of rows) {
    const views = row.views?.length
      ? row.views
      : row.imageId
        ? [{ imageId: row.imageId, label: 'none', source: 'upload' }]
        : []
    assets.set(row.id, { id: row.id, name: row.name ?? '', views })
  }
  return assets
}

function dataUrl(bytes: Uint8Array, contentType: string): string {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return `data:${contentType};base64,${view.toString('base64')}`
}

export const lookRoutes = new Elysia()
  .onError({ as: 'scoped' }, ({ code, set }) => {
    if (code === 'VALIDATION') {
      set.status = 400
      return { error: 'invalid_look_batch' }
    }
  })
  .use(resolveAuthUser)
  .onBeforeHandle(({ set }) => {
    set.headers['cache-control'] = 'private, no-store'
    if (!isCapabilityEnabled('accounts:sync')) return capabilityUnavailable('accounts:sync')
  })
  /**
   * 用一条模板把一批素材跑一遍。素材位只有一个时每条素材各起一个任务；素材位不止一个时
   * 这一批素材按序填满那几个位，只起一个任务。
   *
   * **先全部组装好，再开始建任务**：任一条素材凑不齐就整批拒绝，不留下半批。建任务之后才
   * 出现的失败（积分、配额）按 `/submit` 的同一套状态码回，已经建出来的任务照常进作品流。
   */
  .post(
    '/api/looks/batch',
    async ({ authUser, body, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      if (Boolean(body.lookId) === Boolean(body.skillName)) {
        return status(400, { error: 'invalid_look_batch' })
      }

      const look = body.lookId
        ? await readUserLook(authUser.id, body.lookId)
        : await readBuiltinLook(body.skillName!)
      if (!look) return status(404, { error: 'look_not_found' })

      // 模板钉死了模型，下线了就标「需重新调试」，不替用户换一个。
      const target = look.model ? resolveQueueModel('image', look.model) : undefined
      if (!target || target.model !== look.model) {
        return status(422, { error: 'model_unavailable', model: look.model })
      }

      const assets = await readAssets(authUser.id, body.assetIds)
      const ordered: LookAssemblyAsset[] = []
      for (const assetId of body.assetIds) {
        const asset = assets.get(assetId)
        if (!asset) return status(404, { error: 'asset_not_found', assetId })
        ordered.push(asset)
      }

      const counts: Record<string, number | undefined> = body.counts ?? {}
      for (const assetId of Object.keys(counts)) {
        if (!body.assetIds.includes(assetId)) return status(400, { error: 'invalid_look_batch' })
      }

      const groups = look.slotCount === 1 ? ordered.map((asset) => [asset]) : [ordered]
      const assembled: Array<{
        readonly assetIds: string[]
        readonly prompt: string
        readonly inputImageIds: readonly string[]
        readonly n: number
      }> = []
      for (const group of groups) {
        const result = assembleLookRequest({ look, assets: group })
        if (!result.ok) {
          return status(422, {
            error: result.reason,
            ...(result.assetId ? { assetId: result.assetId } : {}),
          })
        }
        assembled.push({
          assetIds: group.map((asset) => asset.id),
          prompt: result.prompt,
          inputImageIds: result.inputImageIds,
          // 素材位不止一个时整批只有一个任务，张数没有「这一条素材」可依。
          n: (look.slotCount === 1 ? counts[group[0]!.id] : undefined) ?? body.perAsset,
        })
      }

      const references = look.skillName ? new Set(look.referenceImageIds) : null
      const urls = new Map<string, string>()
      const resolveImage = async (imageId: string): Promise<string | null> => {
        const cached = urls.get(imageId)
        if (cached) return cached
        let url: string | null = null
        if (references?.has(imageId)) {
          const file = await readAgentSkillFileBytes('image', look.skillName!, imageId)
          if (file.kind === 'ok') url = dataUrl(file.bytes, file.contentType)
        } else {
          const stored = await readAssetImage(authUser.id, imageId)
          if (stored) url = dataUrl(stored.bytes, stored.contentType)
        }
        if (url) urls.set(imageId, url)
        return url
      }

      const inputs: string[][] = []
      for (const item of assembled) {
        const resolved: string[] = []
        for (const imageId of item.inputImageIds) {
          const url = await resolveImage(imageId)
          if (!url) return status(422, { error: 'image_unavailable', imageId })
          resolved.push(url)
        }
        inputs.push(resolved)
      }

      const tasks: Array<{ assetIds: string[]; taskId: string }> = []
      for (const [index, item] of assembled.entries()) {
        const outcome = await createQueueTask({
          provider: target.provider,
          model: target.model,
          request: {
            prompt: item.prompt,
            ...(look.size ? { size: look.size } : {}),
            n: item.n,
            input_images: inputs[index]!,
            device_id: body.device_id,
          },
          userId: authUser.id,
        })
        if (outcome.kind === 'created') {
          tasks.push({ assetIds: item.assetIds, taskId: outcome.taskId })
          continue
        }
        if (outcome.kind === 'insufficient_credits' || outcome.kind === 'price_unavailable') {
          return reservationFailureResponse(outcome)
        }
        if (outcome.kind === 'quota_exceeded') {
          return status(429, {
            error: 'daily_quota_exceeded',
            quota: outcome.quota.quota,
            used: outcome.quota.count,
            reset_at: outcome.quota.reset_at,
          })
        }
        if (outcome.kind === 'invalid_input_image') {
          return status(400, { error: 'invalid_input_image', message: outcome.message })
        }
        if (outcome.kind === 'object_storage_error') {
          return status(503, { error: 'object_storage_error', message: outcome.message })
        }
        return status(401, { error: 'unauthorized' })
      }

      return { tasks }
    },
    { body: batchBodySchema },
  )
