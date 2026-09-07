import type { CompetitorBrief, ShotType } from '@image-playground/shared'

/** 卖点图上的文案语言。 */
export type RemixLanguage = 'zh' | 'en'

export const REMIX_LEVELS = ['low', 'high'] as const

/** 借创意重做与竞品的距离：低档保留构图，高档只借风格。 */
export type RemixLevel = (typeof REMIX_LEVELS)[number]

/** 锁产品段的原料。主色与禁止色分开填：只说「不得改色」时模型会把产品拉向环境色温。 */
export interface RemixProductDescription {
  name: string
  features: string
  mainColor: string
  forbiddenColors: string[]
}

export const SHOT_TYPE_LABELS: Record<ShotType, string> = {
  main: '主图',
  scene: '场景图',
  topdown: '俯拍图',
  detail: '细节图',
  'selling-point': '卖点图',
  'spec-diagram': '尺寸参数图',
  other: '其它',
}

/** 画面简报。镜型与建议标题另有归属，这里只留其余的可编辑内容。 */
export type RemixBrief = Omit<CompetitorBrief, 'shotType' | 'suggestedTitle'>

/** 卖点图的图上文案，其它镜型不用。 */
export interface RemixShotCopy {
  title: string
  subtitle: string
}
