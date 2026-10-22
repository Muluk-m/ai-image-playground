import type { DiscoveredChannel } from '@image-playground/shared'
import { log } from './logger'
import { loadPrivateBffOverlay } from './private-overlay'

/**
 * 运营停用的模型（私有 overlay 按单价表的 `active=false` 回答）。页面的 `/api/channels`、智能体能用的视频模型、
 * 画布阶段报价都按这一份算：页面上没有的模型，服务端也不能让智能体建节点、报价，否则提案通过、原标签页却拦在
 * 「模型不可用」上。
 *
 * 同步调用方读最近一次查到的那份（{@link knownInactiveModels}）；每一轮开始与 `/api/channels` 会先
 * {@link refreshInactiveModels}。同一时刻的刷新共用一次查询，查到后 {@link INACTIVE_MODELS_TTL_MS} 内不再查。
 * 查询失败时沿用上一次查到的清单，不把它当成「全部上架」；进程启动后一次都没查到时才按全部上架处理，与页面一致：
 * 拿不到模型列表比短暂多露一个停用模型糟得多，那个模型的提交在预扣那一步本来就会被拒。
 */
export const INACTIVE_MODELS_TTL_MS = 10_000
let known: ReadonlySet<string> = new Set()
let fetchedAt: number | undefined
let inflight: Promise<ReadonlySet<string>> | undefined

export function refreshInactiveModels(now = Date.now()): Promise<ReadonlySet<string>> {
  if (fetchedAt !== undefined && now - fetchedAt < INACTIVE_MODELS_TTL_MS)
    return Promise.resolve(known)
  inflight ??= (async () => {
    try {
      const { taskHooks } = await loadPrivateBffOverlay()
      known = (await taskHooks.inactiveModels?.()) ?? new Set()
      fetchedAt = Date.now()
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

export function _resetInactiveModelsForTesting(): void {
  known = new Set()
  fetchedAt = undefined
  inflight = undefined
}
