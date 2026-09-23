import type { ChannelDiscoveryResponse, DiscoveredChannel } from '@image-playground/shared'
import { Elysia } from 'elysia'
import { getDiscoveredChannels } from '../lib/channels'
import { log } from '../lib/logger'
import { loadPrivateBffOverlay } from '../lib/private-overlay'

/**
 * 去掉运营停用的模型；一个模型都不剩的 channel 整条去掉，否则前端会给它注一个没有
 * 可选模型的内置 profile。
 */
function withoutInactiveModels(
  channels: readonly DiscoveredChannel[],
  inactive: ReadonlySet<string>,
): DiscoveredChannel[] {
  if (inactive.size === 0) return [...channels]
  return channels.flatMap((channel) => {
    const models = channel.models.filter((model) => !inactive.has(model.id))
    if (models.length === channel.models.length) return [channel]
    return models.length ? [{ ...channel, models }] : []
  })
}

/**
 * 查不到停用清单时照常全列：页面拿不到模型列表整个工作台就用不了，比短暂多露一个停用模型
 * 糟得多——而那个模型的提交在预扣那一步本来就会被拒。
 */
async function inactiveModels(): Promise<ReadonlySet<string>> {
  try {
    const { taskHooks } = await loadPrivateBffOverlay()
    return (await taskHooks.inactiveModels?.()) ?? new Set()
  } catch (err) {
    log.warn({ event: 'channels.inactive_models_failed', err }, 'inactive model lookup failed')
    return new Set()
  }
}

/**
 * GET /api/channels — 公开端点，`accounts:login` 开着时匿名访客也照样放行。
 *
 * 之所以不设门禁：返回的是 `sanitizeChannel` 处理过的清单，不含 baseUrl / auth /
 * allowedPaths，唯一泄露的信息是「这个部署提供哪些模型」——那本来就写在前端的
 * 模型下拉框上。而未登录的工作台必须先拿到它才渲染得出那个下拉框；在这里要求
 * session，匿名访客连能选什么模型都看不见。真正花钱的动作（submit / queue /
 * sync）各自带 requireUser，门禁在那里，不在发现接口上。
 *
 * 前端 boot 时（在 runtime-config.json 的 bff.enabled=true 前提下）调一次，拿到内置
 * channel 列表组装 profile 与 dispatch 路径。运营停用的模型在这里去掉，前端不用知道
 * 「停用」这回事：清单里没有它，选择器上就没有它。
 *
 * 改这条路由时 sanitization 是硬约束：任何一个凭据面字段漏进 DiscoveredChannel，
 * 就等于对全互联网公开。
 *
 * 没配 channels.json 或 channels.json 是空数组时返回 `{ channels: [] }`，前端
 * 自动退化为「仅 BYOK 可用」。
 */
export const channelsRoutes = new Elysia().get(
  '/api/channels',
  async (): Promise<ChannelDiscoveryResponse> => ({
    channels: withoutInactiveModels(getDiscoveredChannels(), await inactiveModels()),
  }),
)
