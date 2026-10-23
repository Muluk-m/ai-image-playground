import {
  AGENT_CONFIRMATION_PROMPT_MAX_CHARS,
  type AgentToolErrorCode,
  VIDEO_MODEL_SUPPORT,
  type VideoModelSupport,
  type VideoNodeMode,
  type VideoRequest,
  videoNodeModes,
  videoPromptRejection,
  videoRequestRejection,
  videoSupportForCapabilities,
} from '@image-playground/shared'
import { config } from '../../config'
import { isCapabilityEnabled } from '../capabilities'
import { getChannels, resolveQueueModel } from '../channels'
import { knownInactiveModels } from '../model-availability'
import type { QueueTarget } from './tools/queueTask'

export interface AgentVideoModel {
  readonly target: QueueTarget
  readonly support: VideoModelSupport
}

/**
 * Only advertise models whose real channel and supported protocol agree, minus the ones operators
 * stopped: the page's `/api/channels` drops those too, so offering them here would let a proposal
 * pass that the browser then blocks as model_unavailable.
 */
export function agentVideoModels(
  inactive: ReadonlySet<string> = knownInactiveModels(),
): AgentVideoModel[] {
  const found = new Map<string, AgentVideoModel>()
  for (const channel of getChannels()) {
    for (const model of channel.models) {
      if (model.media !== 'video' || found.has(model.id) || inactive.has(model.id)) continue
      const matrix = VIDEO_MODEL_SUPPORT[model.id]
      const target = resolveQueueModel('video', model.id)
      if (!matrix || !target) continue
      found.set(model.id, {
        target,
        support: videoSupportForCapabilities(matrix, model.capabilities),
      })
    }
  }
  return [...found.values()]
}

/** 智能体此刻能不能碰视频：开关开着、且至少一个可用视频模型。页面上的视频入口按同样两条判断。 */
export function agentVideoAvailable(): boolean {
  return isCapabilityEnabled('generation:video') && agentVideoModels().length > 0
}

export const NO_VIDEO_MODEL_MESSAGE =
  '当前部署没有可用的视频模型，不能建视频节点、设置视频模式或为视频节点报价。用户要出图或改图时改建 image 节点；用户要视频时告诉他暂时没有可用的视频模型。'

const VIDEO_NODE_MODE_LABELS: Record<VideoNodeMode, string> = {
  text: '文生',
  first: '首帧',
  frames: '首尾帧',
  reference: '参考生',
}

/** 一个视频模型支持的节点模式，例如「文生（text）、首帧（first）」。 */
export function describeVideoNodeModes(support: VideoModelSupport): string {
  return videoNodeModes(support)
    .map((mode) =>
      mode === 'reference' && support.referenceImages
        ? `参考生（reference，最多 ${support.referenceImages.max} 张）`
        : `${VIDEO_NODE_MODE_LABELS[mode]}（${mode}）`,
    )
    .join('、')
}

/**
 * 视频节点实际会用的模型：节点草稿或本轮工作台点名、且在用的那一个，否则第一个可用的。
 * 与画布报价 `resolveStageVideoExecution` 的挑法相同。
 */
export function agentNodeVideoModel(requested?: string): AgentVideoModel | undefined {
  const models = agentVideoModels()
  return models.find((one) => one.target.model === requested) ?? models[0]
}

/**
 * 视频模式在实际会用的模型上不支持时的说明：列出它支持的模式。支持就返回 null。
 * 不支持的模式不再悄悄退成首帧（图生视频），那样会照扣视频积分却不是用户要的东西。
 */
export function videoNodeModeRejection(mode: string, requested?: string): string | null {
  const resolved = agentNodeVideoModel(requested)
  if (!resolved) return NO_VIDEO_MODEL_MESSAGE
  if ((videoNodeModes(resolved.support) as string[]).includes(mode)) return null
  const label = VIDEO_NODE_MODE_LABELS[mode as VideoNodeMode] ?? mode
  return `视频模式「${label}（${mode}）」当前不可用：${resolved.target.model} 只支持 ${describeVideoNodeModes(resolved.support)}。请换成其中一种；用户要的是出图或改图（例如参考一张图修改另一张）时改建 image 节点。`
}

/** An explicit model is never silently replaced by the deployment default. */
export function agentVideoModel(model?: string): AgentVideoModel | undefined {
  const models = agentVideoModels()
  if (model !== undefined) return models.find((one) => one.target.model === model)
  return models.find((one) => one.target.model === config.agent.videoModel) ?? models[0]
}

/** Recheck frozen drafts and retries before any queue task or credit reservation. */
export function agentVideoRequestError(
  model: string,
  prompt: string,
  video: VideoRequest,
  imageCount: number,
): { code: AgentToolErrorCode; message: string } | null {
  const resolved = agentVideoModel(model)
  if (!isCapabilityEnabled('generation:video') || !resolved)
    return { code: 'model_unavailable', message: '当前没有可用的指定视频模型' }
  if (!prompt.trim() || prompt.length > AGENT_CONFIRMATION_PROMPT_MAX_CHARS)
    return { code: 'invalid_params', message: '视频提示词为空或过长' }
  if (video.reference_image_indices?.length && !resolved.support.referenceImages)
    return { code: 'invalid_params', message: '当前渠道不支持参考图' }
  if (video.voices?.length && !resolved.support.voices)
    return { code: 'invalid_params', message: '当前渠道不支持预设声音' }
  if (video.keyframes?.length && !resolved.support.keyframes)
    return { code: 'invalid_params', message: '当前渠道不支持关键帧' }
  const rejected =
    videoPromptRejection(model, prompt) ?? videoRequestRejection(model, video, imageCount)
  return rejected ? { code: 'invalid_params', message: rejected.reason } : null
}
