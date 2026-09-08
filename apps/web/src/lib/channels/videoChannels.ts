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

/** 图生视频要的模型：当前这个支持首帧就用它，否则退到第一个支持首帧的。 */
export function firstFrameModelOption(modelId: string): VideoModelOption | undefined {
  const options = videoModelOptions()
  const current = options.find((item) => item.modelId === modelId)
  return current?.support.firstFrame ? current : options.find((item) => item.support.firstFrame)
}

/** 整条分镜视频要的模型：当前这个出得了这个时长就用它，否则退到第一个出得了的。 */
export function durationModelOption(
  modelId: string,
  seconds: number,
  needsFirstFrame: boolean,
): VideoModelOption | undefined {
  const fits = (option: VideoModelOption) =>
    (option.support.durations as readonly number[]).includes(seconds) &&
    (!needsFirstFrame || option.support.firstFrame)
  const options = videoModelOptions()
  const current = options.find((item) => item.modelId === modelId)
  return current && fits(current) ? current : options.find(fits)
}

/** 视频入口的可见性。纯静态部署没有 channel，能力清单默认关，两者都要成立。 */
export function isVideoModeAvailable(): boolean {
  return isClientCapabilityEnabled('generation:video') && videoModelOptions().length > 0
}
