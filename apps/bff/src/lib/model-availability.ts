import type { DiscoveredChannel } from '@image-playground/shared'
import { log } from './logger'
import { loadPrivateBffOverlay } from './private-overlay'

/**
 * 运营停用的模型（私有 overlay 按单价表的 `active=false` 回答）。页面的 `/api/channels`、智能体能用的视频模型、
 * 画布阶段报价都按这一份算：页面上没有的模型，服务端也不能让智能体建节点、报价，否则提案通过、原标签页却拦在
 * 「模型不可用」上。
 *
 * 同步调用方读最近一次查到的那份（{@link knownInactiveModels}）；每一轮开始与 `/api/channels` 会先
 * {@link refreshInactiveModels}。查不到时按「全部上架」处理，与页面一致：拿不到模型列表比短暂多露一个停用模型糟得多，
 * 那个模型的提交在预扣那一步本来就会被拒。
 */
let known: ReadonlySet<string> = new Set()

export async function refreshInactiveModels(): Promise<ReadonlySet<string>> {
  try {
    const { taskHooks } = await loadPrivateBffOverlay()
    known = (await taskHooks.inactiveModels?.()) ?? new Set()
  } catch (err) {
    log.warn({ event: 'channels.inactive_models_failed', err }, 'inactive model lookup failed')
    known = new Set()
  }
  return known
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
}
