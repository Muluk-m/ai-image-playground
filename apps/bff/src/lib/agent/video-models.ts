import {
  AGENT_CONFIRMATION_PROMPT_MAX_CHARS,
  type AgentToolErrorCode,
  VIDEO_MODEL_SUPPORT,
  type VideoModelSupport,
  type VideoRequest,
  videoPromptRejection,
  videoRequestRejection,
  videoSupportForCapabilities,
} from '@image-playground/shared'
import { config } from '../../config'
import { isCapabilityEnabled } from '../capabilities'
import { getChannels, resolveQueueModel } from '../channels'
import type { QueueTarget } from './tools/queueTask'

export interface AgentVideoModel {
  readonly target: QueueTarget
  readonly support: VideoModelSupport
}

/** Only advertise models whose real channel and supported protocol agree. */
export function agentVideoModels(): AgentVideoModel[] {
  const found = new Map<string, AgentVideoModel>()
  for (const channel of getChannels()) {
    for (const model of channel.models) {
      if (model.media !== 'video' || found.has(model.id)) continue
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
