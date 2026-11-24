import type { ChannelMedia } from '@image-playground/shared'
import { config } from '../../config'
import { AGENT_IMAGE_FALLBACK_MODEL, type QueueTarget } from '../../modules/agent/contracts'
import { resolveQueueModel } from '../channels'
import { knownInactiveModels } from '../model-availability'

/**
 * 该介质的模型。优先用这一轮里用户选的，解析不出来（模型下线、介质不符）就退回运营配置的，
 * 再没有就取内置 channel 里这一介质的第一个。用户选错模型不该让整轮失败；运营配置的
 * 那个被下线（channels.json `disabled`）也一样，照样落到第一个可用的。
 *
 * 「模型」页停用的（含上游无可用账号时的自动暂停）一律跳过：生图先换到
 * {@link AGENT_IMAGE_FALLBACK_MODEL}，再没有才取第一个没停用的。全都停用时返回空，
 * 工具按「暂时没有可用模型」处理，不再把任务交给一个注定被拒的模型。
 */
export function resolveAgentModel(
  media: ChannelMedia,
  preferred?: string,
  inactive: ReadonlySet<string> = knownInactiveModels(),
): QueueTarget | undefined {
  const live = (id: string | undefined) =>
    id && !inactive.has(id) ? resolveQueueModel(media, id) : undefined
  const configured = media === 'video' ? config.agent.videoModel : config.agent.imageModel
  return (
    live(preferred) ??
    live(configured) ??
    (media === 'image' ? live(AGENT_IMAGE_FALLBACK_MODEL) : undefined) ??
    resolveQueueModel(media, undefined, inactive)
  )
}
