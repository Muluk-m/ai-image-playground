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
      const matrix = VIDEO_MODEL_SUPPORT[model.id]
      if (!matrix) continue
      // 参考图要等渠道声明：旧后端不认这个字段，会把参考图静默丢掉，照样扣费出一段文生视频。
      const { referenceImages: _gated, ...base } = matrix
      const support: VideoModelSupport = model.capabilities?.includes('reference_images')
        ? matrix
        : base
      options.push({
        channelId: channel.id,
        modelId: model.id,
        label: matrix.label,
        support,
      })
    }
  }
  return options
}

/** 当前这个模型合用就用它，否则退到第一个合用的。 */
function pickModelOption(
  modelId: string,
  fits: (option: VideoModelOption) => boolean,
): VideoModelOption | undefined {
  const options = videoModelOptions()
  const current = options.find((item) => item.modelId === modelId)
  return current && fits(current) ? current : options.find(fits)
}

/** 图生视频要的模型。 */
export function firstFrameModelOption(modelId: string): VideoModelOption | undefined {
  return pickModelOption(modelId, (option) => option.support.firstFrame)
}

/** 整条分镜视频要的模型：出得了这个时长的才收得下。 */
export function durationModelOption(
  modelId: string,
  seconds: number,
  needsFirstFrame: boolean,
): VideoModelOption | undefined {
  return pickModelOption(
    modelId,
    (option) =>
      (option.support.durations as readonly number[]).includes(seconds) &&
      (!needsFirstFrame || option.support.firstFrame),
  )
}

/** 视频入口的可见性。纯静态部署没有 channel，能力清单默认关，两者都要成立。 */
export function isVideoModeAvailable(): boolean {
  return isClientCapabilityEnabled('generation:video') && videoModelOptions().length > 0
}
