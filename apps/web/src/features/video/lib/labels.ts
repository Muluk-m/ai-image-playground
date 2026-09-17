import type { VideoDeriveMode, VideoRejection } from '@image-playground/shared'
import { i18next } from '../../../i18n'

/**
 * `packages/shared` 的中文常量只给 BFF 用。界面一律拿稳定 id 回来查译文，
 * 直接渲染那些常量会让英文界面冒中文。
 */
export function videoDeriveLabel(mode: VideoDeriveMode): string {
  return i18next.t(`derive.${mode}`, { ns: 'video' })
}

/**
 * 模型 id 带点号，而点号是 i18next 的层级分隔符，拼不进 key，所以这里显式映射到别名。
 * 支持矩阵里加了模型忘了配译文，这张表会缺一条。
 */
const TAGLINE_KEYS = {
  'grok-imagine-video': 'grok',
  'agnes-video-2.5-flash': 'agnesFlash',
  'doubao-seedance-2-0-mini-260615': 'seedance',
  'veo-3.1-fast-generate-preview': 'veoFast',
  'veo-3.1-lite-generate-preview': 'veoLite',
} as const

/** 模型卡片上的一句话定位。 */
export function videoTaglineLabel(modelId: string): string {
  const key = TAGLINE_KEYS[modelId as keyof typeof TAGLINE_KEYS]
  return key ? i18next.t(`tagline.${key}`, { ns: 'video' }) : ''
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
