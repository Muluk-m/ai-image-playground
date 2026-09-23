import { i18next } from '../../../i18n'

/**
 * 严格局部编辑对送上游那张图的尺寸约束，镜像自
 * `apps/bff/src/lib/agent/masked-edit.config.json` 的 `output`。
 * 服务端才是权威（不合规会抛 `invalid_input_image`），这里只是提前说清楚，
 * 免得用户涂完 / 拖完一轮再吃一个 400。同款镜像常量见
 * `lib/maskPreprocess.ts` 的 `MASK_WORKING_DIMENSION_MULTIPLE`。
 */
export const MASKED_EDIT_MIN_PIXELS = 655_360
export const MASKED_EDIT_MAX_PIXELS = 8_294_400
export const MASKED_EDIT_MAX_EDGE = 3840
export const MASKED_EDIT_MAX_ASPECT = 3

/** 这个尺寸能不能做带遮罩的编辑。返回原因即不能。 */
export function maskedEditSizeRefusal(width: number, height: number): string | null {
  if (width * height < MASKED_EDIT_MIN_PIXELS)
    return i18next.t('inpaint.tooSmall', { ns: 'canvas' })
  if (width * height > MASKED_EDIT_MAX_PIXELS || Math.max(width, height) > MASKED_EDIT_MAX_EDGE)
    return i18next.t('outpaint.tooLarge', { ns: 'canvas' })
  if (Math.max(width / height, height / width) > MASKED_EDIT_MAX_ASPECT)
    return i18next.t('inpaint.tooWide', { ns: 'canvas' })
  return null
}
