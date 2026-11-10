import { type ShotBlock, shot, type VideoBlock, video } from '../model'

/** 指南演示成片。中文界面录制，英文页共用同一文件，说明里写明。 */
export function demo(name: string, alt: string, caption?: string): VideoBlock & { type: 'video' } {
  return video({
    src: `/guide-assets/zh/clips/${name}.mp4`,
    webm: `/guide-assets/zh/clips/${name}.webm`,
    poster: `/guide-assets/zh/clips/${name}-poster.webp`,
    alt,
    caption,
    width: 960,
    height: 600,
  }) as VideoBlock & { type: 'video' }
}

export function promoFilm(alt: string, caption?: string): VideoBlock & { type: 'video' } {
  return video({
    src: '/guide-assets/zh/clips/promo-site-zh.mp4',
    webm: '/guide-assets/zh/clips/promo-site-zh.webm',
    poster: '/guide-assets/zh/clips/promo-site-zh-poster.webp',
    alt,
    caption,
    width: 960,
    height: 540,
  }) as VideoBlock & { type: 'video' }
}

export function still(
  locale: 'zh' | 'en',
  name: string,
  alt: string,
  caption?: string,
  marks?: ShotBlock['marks'],
  width?: number,
): ShotBlock {
  return shot(`/guide-assets/${locale}/${name}.webp`, alt, caption, marks, width)
}
