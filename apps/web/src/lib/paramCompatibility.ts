import { type AppSettings, DEFAULT_PARAMS, type TaskParams } from '../types'
import { clientProfileToApiProfile, getActiveApiProfile } from './apiProfiles'
import { normalizeImageSize } from './size'

export const MAX_OPENAI_OUTPUT_IMAGES = 10

export function getOutputImageLimitForSettings(_settings: AppSettings) {
  return MAX_OPENAI_OUTPUT_IMAGES
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
    size: normalizeImageSize(params.size) || DEFAULT_PARAMS.size,
    n: Math.min(outputImageLimit, Math.max(1, params.n || DEFAULT_PARAMS.n)),
  }

  if (
    activeProfile.source === 'user-byok' &&
    activeProfile.kind === 'openai-compat' &&
    activeProfile.preferences.codexCli
  ) {
    nextParams.quality = DEFAULT_PARAMS.quality
  }

  if (nextParams.output_format === 'png') {
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  } else {
    nextParams.transparent_output = DEFAULT_PARAMS.transparent_output
  }

  // Gemini profile 不展示透明输出开关（ParamControls 同判定），切换 profile 残留的
  // transparent_output 必须重置，否则会静默注入绿幕 prompt 且用户无法关闭。
  // no_rewrite 不用重置：guard 在 callImageApi 分发层已按 provider 排除 gemini，
  // 保留值可以让用户切回 OpenAI 系 profile 时不丢失显式选择。
  if (clientProfileToApiProfile(activeProfile).provider === 'gemini') {
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
