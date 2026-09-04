import type { BackgroundPreset } from '@image-playground/shared'
import type { RemixBrief, RemixProductDescription } from '../types'
import { colorLockLine, joinPromptSections, productIdentityLine, qualitySection } from './prompt'

/** 预设落进简报后就是普通文本，用户可以只改墙面或只改配件。 */
export function backgroundBriefFromPreset(preset: BackgroundPreset): RemixBrief {
  return {
    composition: '',
    camera: '',
    lighting: '',
    background: `${preset.wall}；${preset.floor}`,
    props: [...preset.props],
    textZones: [],
    palette: [],
    productBox: null,
  }
}

/** 换背景版锁产品段：产品原地不动，改的只是它身后那一层。 */
export function backgroundLockSection(product: RemixProductDescription): string {
  return [
    productIdentityLine(product),
    '产品的位置、大小、角度、颜色、材质、缸沿厚度与阴影接地全部保持不变，只替换产品以外的背景，不得重绘、移动或裁切产品。',
    colorLockLine(product),
  ].join('')
}

export function backgroundStyleSection(brief: RemixBrief): string {
  const background = brief.background.trim()
  const props = brief.props.filter((prop) => prop.trim())
  return [
    background ? `背景改为：${background}。` : '',
    props.length > 0 ? `配件：${props.join('、')}。` : '',
  ].join('')
}

export function realismSection(): string {
  return '真实实拍质感：墙面细节轻微不均匀，自然窗光，轻微透视与景深，配件真实可辨，无过度光滑的 CG 感，色调克制。'
}

export interface BackgroundSwapInput {
  product: RemixProductDescription
  brief: RemixBrief
}

export function buildBackgroundSwapPrompt(input: BackgroundSwapInput): string {
  return joinPromptSections([
    backgroundLockSection(input.product),
    backgroundStyleSection(input.brief),
    realismSection(),
    qualitySection(),
  ])
}
