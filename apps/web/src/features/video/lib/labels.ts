import type { VideoDeriveMode, VideoRejection } from '@image-playground/shared'
import { i18next } from '../../../i18n'

/**
 * `packages/shared` 的中文常量只给 BFF 用。界面一律拿稳定 id 回来查译文，
 * 直接渲染那些常量会让英文界面冒中文。
 */
export function videoDeriveLabel(mode: VideoDeriveMode): string {
  return i18next.t(`derive.${mode}`, { ns: 'video' })
}

/** 校验驳回：`reason` 是给 BFF 的中文回执，界面只认 `code`。 */
export function videoRejectionText(found: VideoRejection): string {
  const { frame, mode, ...rest } = found.params
  return i18next.t(`reject.${found.code}`, {
    ns: 'video',
    ...rest,
    ...(frame ? { frame: i18next.t(`frameSlot.${frame}`, { ns: 'video' }) } : {}),
    ...(mode ? { mode: videoDeriveLabel(mode) } : {}),
  })
}
