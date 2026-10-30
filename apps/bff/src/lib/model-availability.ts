import type { DiscoveredChannel } from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { log } from './logger'
import { type BffTransaction, loadPrivateBffOverlay } from './private-overlay'

/**
 * 运营停用的模型，权威在公开库的 `model_availability`（没有行即上架）。页面的 `/api/channels`、智能体能用的
 * 视频模型、画布阶段报价都按这一份算：页面上没有的模型，服务端也不能让智能体建节点、报价，否则提案通过、
 * 原标签页却拦在「模型不可用」上。旧版收费模块把停用记在自己的单价表里，钉住的 overlay 还回答
 * `inactiveModels` 时一并算进来。
 *
 * 同步调用方读最近一次查到的那份（{@link knownInactiveModels}）；每一轮开始与 `/api/channels` 会先
 * {@link refreshInactiveModels}。同一时刻的刷新共用一次查询；表只有几十行、按主键存，不另设缓存，
 * 后台切换「上架」刷新页面就能看到。
 * 查询失败时沿用上一次查到的清单，不把它当成「全部上架」；进程启动后一次都没查到时才按全部上架处理，与页面一致：
 * 拿不到模型列表比短暂多露一个停用模型糟得多，那个模型的提交在 {@link modelUnavailable} 那一步本来就会被拒。
 */
let known: ReadonlySet<string> = new Set()
let inflight: Promise<ReadonlySet<string>> | undefined

async function queryInactiveModels(): Promise<ReadonlySet<string>> {
  const [rows, legacy] = await Promise.all([
    db
      .select({ model: schema.model_availability.model })
      .from(schema.model_availability)
      .where(eq(schema.model_availability.active, false)),
    loadPrivateBffOverlay().then(({ taskHooks }) => taskHooks.inactiveModels?.()),
  ])
  return new Set([...rows.map((row) => row.model), ...(legacy ?? [])])
}

export function refreshInactiveModels(): Promise<ReadonlySet<string>> {
  inflight ??= (async () => {
    try {
      known = await queryInactiveModels()
    } catch (err) {
      log.warn({ event: 'channels.inactive_models_failed', err }, 'inactive model lookup failed')
    } finally {
      inflight = undefined
    }
    return known
  })()
  return inflight
}

/** 最近一次查到的停用模型。 */
export function knownInactiveModels(): ReadonlySet<string> {
  return known
}

/**
 * 去掉停用的模型；一个模型都不剩的 channel 整条去掉，否则前端会给它注一个没有可选模型的内置 profile。
 */
export function withoutInactiveModels<T extends Pick<DiscoveredChannel, 'models'>>(
  channels: readonly T[],
  inactive: ReadonlySet<string> = known,
): T[] {
  if (inactive.size === 0) return [...channels]
  return channels.flatMap((channel) => {
    const models = channel.models.filter((model) => !inactive.has(model.id))
    if (models.length === channel.models.length) return [channel]
    return models.length ? [{ ...channel, models }] : []
  })
}

/**
 * 提交与起轮在落任务行的同一事务里问这一句。停用的模型拒在这里，没刷新的旧页面也打不到上游；
 * 回给调用方的形状与预扣拒绝相同，前端已有对应提示。
 */
export async function modelUnavailable(tx: BffTransaction, model: string): Promise<boolean> {
  const [row] = await tx
    .select({ model: schema.model_availability.model })
    .from(schema.model_availability)
    .where(
      and(eq(schema.model_availability.model, model), eq(schema.model_availability.active, false)),
    )
    .limit(1)
  return Boolean(row)
}

/**
 * 上游明确说这个模型没有可用账号（这类失败不重试，第一次就落成 model_unavailable）：先下架，后面的提交直接被拒，
 * 不再让用户排队等几十秒再退积分。运营在后台补上容量后手动恢复。
 * 只动还上架着的：运营手动下架的不改写成自动暂停。和这次结算同一事务，回滚就一起回滚。
 */
export async function pauseUnavailableModel(
  tx: BffTransaction,
  model: string,
  now: number,
): Promise<void> {
  const table = schema.model_availability
  const paused = await tx
    .insert(table)
    .values({
      model,
      active: false,
      pause_reason: 'upstream_unavailable',
      paused_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: table.model,
      set: { active: false, pause_reason: 'upstream_unavailable', paused_at: now, updated_at: now },
      setWhere: eq(table.active, true),
    })
    .returning({ model: table.model })
  if (!paused.length) return
  await tx.insert(schema.operator_audits).values({
    id: crypto.randomUUID(),
    operator_id: 'system',
    action: 'model.auto_pause',
    target_type: 'model',
    target_id: model,
    details: { reason: 'upstream_unavailable' },
    created_at: now,
  })
  log.warn({ event: 'model.auto_paused', model }, 'model paused: upstream has no eligible account')
}

export interface ModelAvailabilityRow {
  readonly model: string
  readonly active: boolean
  readonly pause_reason: 'upstream_unavailable' | null
  readonly paused_at: number | null
}

/** 登记过的上下架记录，按模型；没登记的模型即上架。 */
export async function listModelAvailability(): Promise<ReadonlyMap<string, ModelAvailabilityRow>> {
  const rows = await db.select().from(schema.model_availability)
  return new Map(
    rows.map((row) => [
      row.model,
      {
        model: row.model,
        active: row.active,
        pause_reason: row.pause_reason ?? null,
        paused_at: row.paused_at ?? null,
      },
    ]),
  )
}

/** 运营手动上下架。恢复上架连带清掉自动暂停的记录；手动下架不写原因。 */
export async function setModelActive(input: {
  model: string
  active: boolean
  operatorId: string
}): Promise<void> {
  const now = Date.now()
  const row = { active: input.active, pause_reason: null, paused_at: null, updated_at: now }
  await db.transaction(async (tx) => {
    await tx
      .insert(schema.model_availability)
      .values({ model: input.model, ...row })
      .onConflictDoUpdate({ target: schema.model_availability.model, set: row })
    await tx.insert(schema.operator_audits).values({
      id: crypto.randomUUID(),
      operator_id: input.operatorId,
      action: 'model.availability.update',
      target_type: 'model',
      target_id: input.model,
      details: { active: input.active },
      created_at: now,
    })
  })
  await refreshInactiveModels()
}

export function _resetInactiveModelsForTesting(): void {
  known = new Set()
  inflight = undefined
}
