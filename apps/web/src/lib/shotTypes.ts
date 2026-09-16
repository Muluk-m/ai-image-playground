import type { CompetitorBrief, ShotType } from '@image-playground/shared'
import { i18next } from '../i18n'

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

function buildShotTypeLabels(): Record<ShotType, string> {
  return {
    main: i18next.t('shotType.main', { ns: 'lib' }),
    scene: i18next.t('shotType.scene', { ns: 'lib' }),
    topdown: i18next.t('shotType.topdown', { ns: 'lib' }),
    detail: i18next.t('shotType.detail', { ns: 'lib' }),
    'selling-point': i18next.t('shotType.sellingPoint', { ns: 'lib' }),
    'spec-diagram': i18next.t('shotType.specDiagram', { ns: 'lib' }),
    other: i18next.t('shotType.other', { ns: 'lib' }),
  }
}

/** `export let` 的 live binding：语言切换后已 import 这张表的模块读到的是新一份。 */
export let SHOT_TYPE_LABELS: Record<ShotType, string> = buildShotTypeLabels()
i18next.on('languageChanged', () => {
  SHOT_TYPE_LABELS = buildShotTypeLabels()
})

/** 画面简报。镜型与建议标题另有归属，这里只留其余的可编辑内容。 */
export type RemixBrief = Omit<CompetitorBrief, 'shotType' | 'suggestedTitle'>

/** 卖点图的图上文案，其它镜型不用。 */
export interface RemixShotCopy {
  title: string
  subtitle: string
}
