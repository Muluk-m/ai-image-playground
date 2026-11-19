import { type ShotBlock, shot, type VideoBlock, video } from '../model'
import { siteAssetUrl } from './siteAssets'

/** 成片上传至 ai-images 的 muvloom/site/clips/；发布前按 README 验证公开地址。 */
export const GUIDE_CLIP_URLS = {
  '01-first-image.mp4':
    'https://store.kaleidonova.com/muvloom/site/clips/01-first-image-95a22c23bb3d.mp4',
  '01-first-image.webm':
    'https://store.kaleidonova.com/muvloom/site/clips/01-first-image-78856244c7d0.webm',
  '02-reference-image.mp4':
    'https://store.kaleidonova.com/muvloom/site/clips/02-reference-image-0f6c2ba20a86.mp4',
  '02-reference-image.webm':
    'https://store.kaleidonova.com/muvloom/site/clips/02-reference-image-a5ecdea930d2.webm',
  '03-generation-settings.mp4':
    'https://store.kaleidonova.com/muvloom/site/clips/03-generation-settings-698020af7606.mp4',
  '03-generation-settings.webm':
    'https://store.kaleidonova.com/muvloom/site/clips/03-generation-settings-631b45d18d5d.webm',
  '04-gpt26-gif.mp4':
    'https://store.kaleidonova.com/muvloom/site/clips/04-gpt26-gif-daddc0668dfe.mp4',
  '04-gpt26-gif.webm':
    'https://store.kaleidonova.com/muvloom/site/clips/04-gpt26-gif-6cea6695a62d.webm',
  '05-gpt26-svg.mp4':
    'https://store.kaleidonova.com/muvloom/site/clips/05-gpt26-svg-b89a3c89e280.mp4',
  '05-gpt26-svg.webm':
    'https://store.kaleidonova.com/muvloom/site/clips/05-gpt26-svg-56d3fdf2fbc3.webm',
  '06-batch-each.mp4':
    'https://store.kaleidonova.com/muvloom/site/clips/06-batch-each-09cbd6cf755d.mp4',
  '06-batch-each.webm':
    'https://store.kaleidonova.com/muvloom/site/clips/06-batch-each-fa896917f7c6.webm',
  '07-agent-chat.mp4':
    'https://store.kaleidonova.com/muvloom/site/clips/07-agent-chat-ad95ab534a0c.mp4',
  '07-agent-chat.webm':
    'https://store.kaleidonova.com/muvloom/site/clips/07-agent-chat-b97fba6933f1.webm',
  '08-video.mp4': 'https://store.kaleidonova.com/muvloom/site/clips/08-video-8ac5414dc76c.mp4',
  '08-video.webm': 'https://store.kaleidonova.com/muvloom/site/clips/08-video-c59cf4c763a0.webm',
  '09-inpaint.mp4': 'https://store.kaleidonova.com/muvloom/site/clips/09-inpaint-8d4316d59353.mp4',
  '09-inpaint.webm':
    'https://store.kaleidonova.com/muvloom/site/clips/09-inpaint-8108017ae1de.webm',
  '10-explore-remix.mp4':
    'https://store.kaleidonova.com/muvloom/site/clips/10-explore-remix-2efd68487b92.mp4',
  '10-explore-remix.webm':
    'https://store.kaleidonova.com/muvloom/site/clips/10-explore-remix-5f7deb96fe29.webm',
  '11-toolbox-crop.mp4':
    'https://store.kaleidonova.com/muvloom/site/clips/11-toolbox-crop-895667ce5f13.mp4',
  '11-toolbox-crop.webm':
    'https://store.kaleidonova.com/muvloom/site/clips/11-toolbox-crop-a8e1e45db698.webm',
  'promo-site-zh.mp4':
    'https://store.kaleidonova.com/muvloom/site/clips/promo-site-zh-ccb0040581bf.mp4',
  'promo-site-zh.webm':
    'https://store.kaleidonova.com/muvloom/site/clips/promo-site-zh-cda70635b35c.webm',
  'remix.mp4': 'https://store.kaleidonova.com/muvloom/site/clips/remix-f90dbcd5047f.mp4',
  'remix.webm': 'https://store.kaleidonova.com/muvloom/site/clips/remix-c04b9ed281f0.webm',
  'settings.mp4': 'https://store.kaleidonova.com/muvloom/site/clips/settings-24575f51d470.mp4',
  'settings.webm': 'https://store.kaleidonova.com/muvloom/site/clips/settings-74437b174ff7.webm',
  'workbuddy-tutorial.mp4':
    'https://store.kaleidonova.com/muvloom/site/clips/workbuddy-tutorial-4e23ed5c4f95.mp4',
  'workbuddy-tutorial.webm':
    'https://store.kaleidonova.com/muvloom/site/clips/workbuddy-tutorial-0450c6e40878.webm',
} as const

export type GuideClipFile = keyof typeof GUIDE_CLIP_URLS

const POSTER_DIR = '/guide-assets/zh/clips'

export function guideClipUrl(file: GuideClipFile): string {
  return GUIDE_CLIP_URLS[file]
}

function isGuideClip(file: string): file is GuideClipFile {
  return Object.prototype.hasOwnProperty.call(GUIDE_CLIP_URLS, file)
}

function clipSources(stem: string): { src: string; webm: string; poster: string } {
  const mp4 = `${stem}.mp4`
  const webm = `${stem}.webm`
  if (!isGuideClip(mp4) || !isGuideClip(webm)) throw new Error(`指南成片未登记 CDN 地址：${stem}`)
  return {
    src: GUIDE_CLIP_URLS[mp4],
    webm: GUIDE_CLIP_URLS[webm],
    poster: siteAssetUrl(`${POSTER_DIR}/${stem}-poster.webp`),
  }
}

/** 指南演示成片。中文界面录制，英文页共用同一文件，说明里写明。 */
export function demo(name: string, alt: string, caption?: string): VideoBlock & { type: 'video' } {
  return video({
    ...clipSources(name),
    alt,
    caption,
    width: 960,
    height: 600,
  }) as VideoBlock & { type: 'video' }
}

export function promoFilm(alt: string, caption?: string): VideoBlock & { type: 'video' } {
  return video({
    ...clipSources('promo-site-zh'),
    alt,
    caption,
    width: 960,
    height: 540,
    film: true,
  }) as VideoBlock & { type: 'video' }
}

/** 完整的 WorkBuddy 安装、授权、生成与两端查看流程。 */
export function workbuddyFilm(alt: string, caption?: string): VideoBlock & { type: 'video' } {
  return video({
    ...clipSources('workbuddy-tutorial'),
    alt,
    caption,
    width: 960,
    height: 540,
    film: true,
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
  return shot(siteAssetUrl(`/guide-assets/${locale}/${name}.webp`), alt, caption, marks, width)
}
