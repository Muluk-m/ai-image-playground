import { i18next } from '../../../i18n'

/**
 * 带遮罩编辑的尺寸约束。服务端（`apps/bff/src/lib/agent/masked-input.ts`）已不设尺寸门槛：
 * 原尺寸送不上去（太小、太大、太扁）时会在选区周围截图并缩放到上游支持的尺寸，结果拉回原尺寸、
 * 只在选区内合成。这里只剩解码上限，镜像 `apps/bff/src/lib/media-image-limits.ts` 的
 * `MEDIA_IMAGE_MAX_PIXELS`，免得用户涂完一轮再吃一个 400。
 */
export const MASKED_EDIT_MAX_PIXELS = 40_000_000

/** 这个尺寸能不能做带遮罩的编辑。返回原因即不能。 */
export function maskedEditSizeRefusal(width: number, height: number): string | null {
  if (width * height > MASKED_EDIT_MAX_PIXELS)
    return i18next.t('outpaint.tooLarge', { ns: 'canvas' })
  return null
}
