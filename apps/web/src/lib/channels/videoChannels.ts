import { VIDEO_MODEL_SUPPORT, type VideoModelSupport } from '@image-playground/shared'
import { isClientCapabilityEnabled } from '../clientCapabilities'
import { getStoredChannels } from './channelStore'

/** 一个可提交的视频模型：来自哪条 channel，以及它的档位支持矩阵。 */
export interface VideoModelOption {
  channelId: string
  modelId: string
  label: string
  support: VideoModelSupport
}

export function videoModelOptions(): VideoModelOption[] {
  const options: VideoModelOption[] = []
  for (const channel of getStoredChannels()) {
    for (const model of channel.models) {
      if (model.media !== 'video') continue
      const support = VIDEO_MODEL_SUPPORT[model.id]
      if (!support) continue
      options.push({
        channelId: channel.id,
        modelId: model.id,
        label: support.label,
        support,
      })
    }
  }
  return options
}

/** 视频入口的可见性。纯静态部署没有 channel，能力清单默认关，两者都要成立。 */
export function isVideoModeAvailable(): boolean {
  return isClientCapabilityEnabled('generation:video') && videoModelOptions().length > 0
}
