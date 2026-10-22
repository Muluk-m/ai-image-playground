import { nearestImageSize } from '@image-playground/shared'
import { type AppSettings, DEFAULT_PARAMS, type GeminiImageSize, type TaskParams } from '../types'
import { clientProfileToApiProfile, getActiveApiProfile } from './apiProfiles'
import { getModelCapabilities, getModelImageSizes } from './channels/profileSelectors'
import { getPublicChannels } from './channels/publicChannels'
import type { ClientProfile } from './channels/types'
import { normalizeImageSize } from './size'

export const MAX_OPENAI_OUTPUT_IMAGES = 10

export function getOutputImageLimitForSettings(_settings: AppSettings) {
  return MAX_OPENAI_OUTPUT_IMAGES
}

export interface ParamCapabilities {
  quality: boolean
  size: boolean
  transparentOutput: boolean
  compression: boolean
  /**
   * 分辨率（gemini_image_size）与思考级别（gemini_thinking_level）。
   * 比例不在此列：走 gemini 协议时它顶的是尺寸控件的位置，任何模型都得有一个。
   */
  geminiImageTuning: boolean
  /** 分辨率面板列的档位：渠道给模型声明了 `imageSizes` 就只有这几档。 */
  geminiImageSizes: readonly GeminiImageSize[]
}

/**
 * 是不是 Gemini 系的图像模型。同一个 gemini 协议下也能填 imagen 这类别的模型，
 * 那些模型认不得分辨率与思考级别——显示了却不生效，比没有这个开关更糟。
 */
function isGeminiSeriesModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith('gemini')
}

/**
 * 「这个 profile 下哪些参数可用」的唯一权威：UI chip 显隐（ParamControls / InputBar）
 * 与下面的 normalize 共用同一判定，不再各自推导。
 */
export function getParamCapabilities(
  profile: ClientProfile,
  outputFormat: TaskParams['output_format'],
): ParamCapabilities {
  const view = clientProfileToApiProfile(profile)
  const modelCaps = getModelCapabilities(profile, getPublicChannels())
  return {
    quality: !view.codexCli && (!modelCaps || modelCaps.has('quality')),
    size: !modelCaps || modelCaps.has('size'),
    transparentOutput: view.provider !== 'gemini' && outputFormat === 'png',
    compression: outputFormat !== 'png',
    geminiImageTuning: view.provider === 'gemini' && isGeminiSeriesModel(view.model),
    geminiImageSizes: getModelImageSizes(profile, getPublicChannels()),
  }
}

export function normalizeParamsForSettings(
  params: TaskParams,
  settings: AppSettings,
  _options: { hasInputImages?: boolean } = {},
): TaskParams {
  const activeProfile = getActiveApiProfile(settings)
  const outputImageLimit = getOutputImageLimitForSettings(settings)
  const nextParams: TaskParams = {
    ...params,
    moderation: DEFAULT_PARAMS.moderation,
    size: normalizeImageSize(params.size) || DEFAULT_PARAMS.size,
    n: Math.min(outputImageLimit, Math.max(1, params.n || DEFAULT_PARAMS.n)),
  }

  const caps = getParamCapabilities(activeProfile, nextParams.output_format)
  // 切到不认这一档的模型（如从 2.1 的 2K 切到 Lite、本地存着旧的 512）：换成最近一档，
  // 面板、摘要和提交看到的是同一个值，和 BFF 兜底的换法一致。
  if (nextParams.gemini_image_size) {
    nextParams.gemini_image_size = nearestImageSize(
      nextParams.gemini_image_size,
      caps.geminiImageSizes,
    )
  }
  if (!caps.compression) {
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  }
  if (!caps.transparentOutput) {
    // Gemini profile 不展示透明输出开关、非 png 格式同理；切换 profile / 格式残留的
    // transparent_output 必须重置，否则会静默注入绿幕 prompt 且用户无法关闭。
    // no_rewrite 不用重置：guard 在 callImageApi 分发层已按 provider 排除 gemini，
    // 保留值可以让用户切回 OpenAI 系 profile 时不丢失显式选择。
    nextParams.transparent_output = DEFAULT_PARAMS.transparent_output
  }

  return nextParams
}

export function getChangedParams(current: TaskParams, next: TaskParams): Partial<TaskParams> {
  const patch: Partial<TaskParams> = {}
  for (const key of Object.keys(next) as Array<keyof TaskParams>) {
    if (current[key] !== next[key]) {
      ;(patch as Record<keyof TaskParams, TaskParams[keyof TaskParams]>)[key] = next[key]
    }
  }
  return patch
}
