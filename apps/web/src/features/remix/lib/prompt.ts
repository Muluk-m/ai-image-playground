import type { ShotType } from '@image-playground/shared'
import type {
  RemixBrief,
  RemixLanguage,
  RemixLevel,
  RemixProductDescription,
  RemixShotCopy,
} from '../types'

const LANGUAGE_NAMES: Record<RemixLanguage, string> = { zh: '中文', en: '英文' }

/** 尺寸图与参数表是密集文字，生图模型做不了，只占位。 */
export function isRenderableShotType(type: ShotType): boolean {
  return type !== 'spec-diagram'
}

/** 分析请求里的产品说明：视觉模型要靠它认出画面里该被替换的是哪一件。 */
export function productContextDescription(product: RemixProductDescription): string {
  const parts = [product.features.trim()].filter(Boolean)
  if (product.mainColor.trim()) parts.push(`主色：${product.mainColor.trim()}`)
  if (product.forbiddenColors.length > 0) {
    parts.push(`不得出现的颜色：${product.forbiddenColors.join(' / ')}`)
  }
  return parts.join('。')
}

export interface ShotPromptInput {
  type: ShotType
  product: RemixProductDescription
  brief: RemixBrief
  copy: RemixShotCopy
  level: RemixLevel
  language: RemixLanguage
}

/** 产品自报家门的一句，锁产品段与换背景锁产品段共用。 */
export function productIdentityLine(product: RemixProductDescription): string {
  const features = product.features.trim()
  return `图1是我方产品：${product.name.trim()}${features ? `，${features}` : ''}。`
}

/** 颜色要点名目标色与误判色，只说「不得改色」时模型会把产品拉向环境色温。 */
export function colorLockLine(product: RemixProductDescription): string {
  const mainColor = product.mainColor.trim()
  if (!mainColor) return ''
  const forbidden = product.forbiddenColors.filter((color) => color.trim())
  return `必须保持${mainColor}${forbidden.length > 0 ? `，不得变成${forbidden.join(' / ')}` : ''}，环境光再暖再暗固有色也不变。`
}

export function productLockSection(product: RemixProductDescription): string {
  return [
    productIdentityLine(product),
    '严格保留款式、轮廓比例、颜色、材质质感，不得变形、不得换成别的产品。',
    colorLockLine(product),
  ].join('')
}

/** 参考约束段：高档只借风格，低档保留构图。 */
export function referenceConstraintSection(level: RemixLevel): string {
  return level === 'high'
    ? '图2只作为风格与档次参考，禁止照搬其构图、机位、道具摆位、挂画、地毯与配件，画面必须与图2明显不同。'
    : '图2只作为构图、机位与布光参考，不要复制图2里的产品。'
}

export function shotDescriptionSection(brief: RemixBrief): string {
  const fields: Array<[string, string]> = [
    ['画面', brief.composition],
    ['机位', brief.camera],
    ['光线', brief.lighting],
    ['背景', brief.background],
    ['道具', brief.props.join('、')],
    ['配色', brief.palette.join('、')],
  ]
  return fields
    .filter(([, value]) => value.trim())
    .map(([label, value]) => `${label}：${value.trim()}。`)
    .join('')
}

/** 差异化替换段：从简报的背景与道具派生「改为…」，只在高档用。 */
export function differentiationSection(brief: RemixBrief): string {
  const background = brief.background.trim()
  const props = brief.props.filter((prop) => prop.trim())
  if (!background && props.length === 0) return ''
  const swap = background
    ? `背景改为与「${background}」不同的另一处场景，地面、配件与道具一并改为另一组`
    : '背景、地面、配件与道具全部改为另一组'
  return `${swap}${props.length > 0 ? `，不出现${props.join('、')}` : ''}。`
}

/** 卖点文案段：图上要出文字的镜头才加。 */
export function copySection(copy: RemixShotCopy, language: RemixLanguage): string {
  const title = copy.title.trim()
  const subtitle = copy.subtitle.trim()
  if (!title && !subtitle) return ''
  const parts = [title && `标题「${title}」`, subtitle && `副标题「${subtitle}」`].filter(Boolean)
  return `图上文案用${LANGUAGE_NAMES[language]}：${parts.join('，')}，拼写必须准确。`
}

/** 品质段。`onImageText` 为真时不写「无文字」，位置留给卖点文案段。 */
export function qualitySection(onImageText = false): string {
  return onImageText
    ? '商业电商产品图，8K 超写实，无水印。'
    : '商业电商产品图，8K 超写实，无文字无水印。'
}

export function joinPromptSections(sections: string[]): string {
  return sections.filter(Boolean).join('\n')
}

export function buildShotPrompt(input: ShotPromptInput): string {
  if (!isRenderableShotType(input.type)) return ''

  const sellingPoint = input.type === 'selling-point'
  return joinPromptSections([
    productLockSection(input.product),
    referenceConstraintSection(input.level),
    shotDescriptionSection(input.brief),
    input.level === 'high' ? differentiationSection(input.brief) : '',
    qualitySection(sellingPoint),
    sellingPoint ? copySection(input.copy, input.language) : '',
  ])
}
