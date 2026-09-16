import { type AppSettings, DEFAULT_PARAMS, type TaskParams } from '../types'
import { clientProfileToApiProfile, getActiveApiProfile } from './apiProfiles'
import { getModelCapabilities } from './channels/profileSelectors'
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

  if (
    activeProfile.source === 'user-byok' &&
    activeProfile.kind === 'openai-compat' &&
    activeProfile.preferences.codexCli
  ) {
    // 注意只用 codexCli 判定，不用 capabilities.quality：channel capability 缺 quality
    // 只影响 UI 显隐，不在归一化层重置（保持既有线上行为）。
    nextParams.quality = DEFAULT_PARAMS.quality
  }

  const caps = getParamCapabilities(activeProfile, nextParams.output_format)
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
