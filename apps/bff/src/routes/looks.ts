import {
  assembleLookRequest,
  isBlankPrompt,
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
import {
  type BffTransaction,
  loadPrivateBffOverlay,
  reservationFailureResponse,
} from '../lib/private-overlay'
import { readAssetImage } from '../lib/sync-assets'
import {
  type CreateQueueTaskInput,
  type CreateQueueTaskOutcome,
  createQueueTask,
  discardQueueTaskPreparation,
  type PreparedQueueTask,
  prepareQueueTask,
} from '../lib/taskSubmission'
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

type BatchRefusal = Exclude<CreateQueueTaskOutcome, { kind: 'created' }>

/** 建到某一条被拒：抛出来让整批事务回滚，前面已经建好、预扣好的任务一并撤销。 */
class BatchRefused extends Error {
  constructor(readonly outcome: BatchRefusal) {
    super(outcome.kind)
  }
}

/**
 * 积分不够时按整批报：要多少是整批的总价，手里有多少是这一批开始之前的余额。
 * 单价只有私有账本知道，问不到报价就退回这一条自己的缺口。
 */
async function batchShortfall(
  tx: BffTransaction,
  userId: string,
  model: string,
  counts: readonly number[],
  failedAt: number,
  failure: Extract<BatchRefusal, { kind: 'insufficient_credits' }>,
): Promise<BatchRefusal> {
  const { quoteTask } = (await loadPrivateBffOverlay()).taskHooks
  if (!quoteTask) return failure
  const quotes: number[] = []
  for (const quantity of counts) {
    const quote = await quoteTask({ tx, userId, model, quantity, unitMultiplier: 1 })
    if (!quote) return failure
    quotes.push(quote.estimatedCredits)
  }
  const held = quotes.slice(0, failedAt).reduce((sum, credits) => sum + credits, 0)
  return {
    kind: 'insufficient_credits',
    required: quotes.reduce((sum, credits) => sum + credits, 0),
    available: failure.available + held,
  }
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
   * **先全部组装好，再在一个事务里把整批建完**：任一条素材凑不齐、或积分 / 配额不够建完整批，
   * 都整批拒绝，一个任务都不建、一分都不预扣。状态码与 `/submit` 相同；积分不够时 402 报的是
   * 整批的总价与这一批之前的余额。
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

      // 整批先校验提示词：中途某条被拒时，前面的已经入队预扣，会变成部分成功。
      if (assembled.some((item) => isBlankPrompt(item.prompt)))
        return status(400, { error: 'invalid_request', message: '提示词不能为空' })

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

      const createInputs: CreateQueueTaskInput[] = assembled.map((item, index) => ({
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
      }))
      // 输入图先全部归档，再开事务：握着积分锁和连接时不去等对象存储。
      const prepared: PreparedQueueTask[] = []
      const discardAll = () => Promise.all(prepared.map((one) => discardQueueTaskPreparation(one)))
      for (const input of createInputs) {
        const preparation = await prepareQueueTask(input)
        if (preparation.kind !== 'prepared') {
          await discardAll()
          return refusalResponse(preparation)
        }
        prepared.push(preparation.prepared)
      }

      let tasks: Array<{ assetIds: string[]; taskId: string }>
      try {
        tasks = await db.transaction(async (tx) => {
          const created: Array<{ assetIds: string[]; taskId: string }> = []
          for (const [index, input] of createInputs.entries()) {
            const outcome = await createQueueTask({ ...input, prepared: prepared[index]!, tx })
            if (outcome.kind === 'created') {
              created.push({ assetIds: assembled[index]!.assetIds, taskId: outcome.taskId })
              continue
            }
            throw new BatchRefused(
              outcome.kind === 'insufficient_credits'
                ? await batchShortfall(
                    tx,
                    authUser.id,
                    target.model,
                    assembled.map((item) => item.n),
                    index,
                    outcome,
                  )
                : outcome,
            )
          }
          return created
        })
      } catch (error) {
        await discardAll()
        if (error instanceof BatchRefused) return refusalResponse(error.outcome)
        throw error
      }

      function refusalResponse(outcome: BatchRefusal) {
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
        if (outcome.kind === 'invalid_prompt') {
          return status(400, { error: 'invalid_request', message: '提示词不能为空' })
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
