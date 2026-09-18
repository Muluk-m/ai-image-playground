import {
  type VideoRejection,
  type VideoRequest,
  videoRequestRejection,
} from '@image-playground/shared'
import { type VideoModelOption, videoModelOptions } from '../../../lib/channels/videoChannels'

/**
 * 画布提交前的校验：矩阵之外再认渠道门控。参考图要渠道声明过才放行，否则按「不支持参考图」拦下，
 * 和面板上的说明、BFF 的驳回同一个 code——旧后端会把参考图静默丢掉、照样扣费出一段文生视频。
 */
export function videoOptionRejection(
  modelId: string,
  video: VideoRequest,
  inputImageCount: number,
): VideoRejection | null {
  const option = videoModelOptions().find((one) => one.modelId === modelId)
  if (option && (video.reference_image_indices?.length ?? 0) > 0 && !option.support.referenceImages)
    return {
      code: 'referenceUnsupported',
      params: { label: option.label },
      reason: `${option.label} 不支持参考图`,
    }
  return videoRequestRejection(modelId, video, inputImageCount)
}

/** 带得了参考图的模型：当前这个带得了就用它，否则第一个带得了的。 */
export function referenceModelOption(modelId: string): VideoModelOption | undefined {
  const options = videoModelOptions().filter((one) => one.support.referenceImages)
  return options.find((one) => one.modelId === modelId) ?? options[0]
}
