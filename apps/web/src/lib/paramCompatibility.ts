import { type AppSettings, DEFAULT_PARAMS, type TaskParams } from '../types'
import { getActiveApiProfile } from './apiProfiles'
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
    nextParams.transparent_output = false
  }

  if (_options.hasInputImages) {
    nextParams.transparent_output = false
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
