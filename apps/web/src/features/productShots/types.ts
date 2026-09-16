import type { BgSceneType, ProductBox, PromptLanguage, ShotType } from '@image-playground/shared'
import { i18next } from '../../i18n'
import type { ProductAsset } from '../../lib/productAngle'
import type {
  MatteBackendId,
  MatteCoverageReason,
  SegmentFailureReason,
} from '../../lib/productMatte'
import type {
  RemixBrief,
  RemixLevel,
  RemixProductDescription,
  RemixShotCopy,
} from '../../lib/shotTypes'
import type { ProductShotAction } from './lib/actions'
import type { WorkflowRecipe } from './workflows/plan'

// `getFixedT(null, ns)` 把命名空间钉死、语言不钉：key 受 productShots 的类型约束，
// 每次调用仍取当前语言。手写 `Parameters<typeof i18next.t>[0]` 拿到的是全部命名空间的
// 并集，配上 `ns` 反而对不上，key 也就失去了编译期检查。
const t = i18next.getFixedT(null, 'productShots')

/** 旧任务记录里的两组分段，只用来把老记录读成一个动作。 */
export type LegacyProductSource = 'original' | 'asset'
export type LegacyTarget = 'product-only' | 'product-and-background'

export const SOURCE_MODES = ['upload', 'listing', 'library'] as const

/** 原图从哪来：自己上传、贴商品链接抓、还是从素材库里挑。 */
export type SourceMode = (typeof SOURCE_MODES)[number]

export function sourceModeLabels(): Record<SourceMode, string> {
  return {
    upload: t('source.mode.upload'),
    listing: t('source.mode.listing'),
    library: t('source.mode.library'),
  }
}

/** 抠图没用上的原因：浏览器链跑不出来、服务端挂了、占比不对，或抠出来的框跟产品框对不上。 */
export type MatteFailureCause =
  | SegmentFailureReason
  | MatteCoverageReason
  | 'server'
  | 'box-mismatch'
  | 'missing'

export function editMaskLabel(): string {
  return t('matte.editMask')
}

/** box-mismatch 自带一句「蒙版不可靠」，不在这张表里。 */
export function matteFailureLabels(): Record<Exclude<MatteFailureCause, 'box-mismatch'>, string> {
  return {
    timeout: t('matte.failure.timeout'),
    unsupported: t('matte.failure.unsupported'),
    failed: t('matte.failure.failed'),
    server: t('matte.failure.server'),
    missing: t('matte.failure.missing'),
    'too-small': t('matte.failure.tooSmall'),
    'too-large': t('matte.failure.tooLarge'),
  }
}

/** 蒙版编辑器与门禁都问这一条：抠出来的 alpha 还在不在。 */
export function matteEditable(matte: SourceMatte | undefined): matte is MatteWithAlpha {
  return matte !== undefined && matte.status !== 'failed'
}

/** 抠图这一段的结果：成功记抠出它的后端，失败记原因。 */
export type MatteOutcome =
  | { ok: true; backend: MatteBackendId }
  | { ok: false; reason: MatteFailureCause }

/** 蒙版的外接框与方案给的产品框对不对得上。 */
export type MatteAgreement = 'ok' | 'box-mismatch'

/** 抠出来的那份 alpha 与它落盘的三张图。 */
interface MatteAlpha {
  backend: MatteBackendId
  /** alpha 通道即保留区；手改过的就是编辑器存下来的那张。 */
  alphaImageId: string
  /** alpha 对着的那张图：手改会按官方尺寸改图。 */
  targetImageId: string
  previewImageId: string
  edited: boolean
  /** 最近一次动作算出的一致性，只喂芯片，不参与派生。 */
  agreement?: MatteAgreement
}

/**
 * 原图身上的蒙版。只存 alpha：遮罩与一致性都在动作那一刻按当时的产品框现算，不落盘。
 * `unusable` 是抠出来了但占比不对：动作照挡，alpha 留着让用户手改成可用的。
 */
export type SourceMatte =
  | { status: 'failed'; reason: MatteFailureCause; previewImageId: string | null }
  | (MatteAlpha & { status: 'unusable'; reason: MatteCoverageReason })
  | (MatteAlpha & { status: 'ready' })

export type MatteWithAlpha = Extract<SourceMatte, { status: 'ready' | 'unusable' }>

/** 一次动作的产出。`masked` 为假是蒙版失败的提示词版，产品像素没被锁住。 */
export interface ProductShotVersion {
  workflow?: WorkflowRecipe

  id: string
  taskId: string
  plan: string
  prompt: string
  /** 方案给的产品框，重跑时拿它再校一次蒙版；旧记录没有这个字段。 */
  productBox?: ProductBox | null
  /** 这一版认定的产品清单；旧记录与方案没列出清单时没有这个字段，按空清单读。 */
  inventory?: readonly string[]
  masked: boolean
  /** 这一版跑的是哪个动作；旧记录没有这个字段，按只换背景读。 */
  mode?: ProductShotAction
  /** 与竞品的距离，只有借创意重做有。 */
  level?: RemixLevel
  /** 借创意重做那一版的简报，重跑与「查看方案」拿它；其余动作没有。 */
  brief?: RemixBrief
  /** 简报判出的镜型，抽屉里重算提示词要它；只有借创意重做有。 */
  shotType?: ShotType
  /** 卖点图的图上文案，抽屉里可改；其余镜型没有。 */
  copy?: RemixShotCopy
  /** 提示词被人手改过：之后改简报字段不再覆盖它。 */
  promptEdited?: boolean
  /** 换产品与借创意重做时用掉的那条素材；只换背景时没有。 */
  productAssetId?: string
  /** 这一版落盘时还没有这个字段的旧记录为 undefined。 */
  matte?: MatteOutcome
  /** 抠出来的蒙版叠在原图上的预览图；抠图没跑出结果时没有。 */
  mattePreviewImageId?: string
  /** 这一版用掉的蒙版，手改蒙版与照它重生成都拿它当底；回落成提示词版时没有。 */
  maskImageId?: string
  /** 蒙版对着的那张图：遮罩编辑会按官方尺寸改图，重生成必须提交这一张。 */
  maskTargetImageId?: string
  /** 源图短边低于门槛，细节本来就上不去；版本条上要标出来。 */
  lowResSource?: boolean
  createdAt: number
}

/** 出一版要走的三段，读秒按段切换。 */
export type ProductShotStage = 'plan' | 'matte' | 'generate'

export function productShotStageLabels(): Record<ProductShotStage, string> {
  return {
    plan: t('stage.plan'),
    matte: t('matte.matting'),
    generate: i18next.t('state.generating', { ns: 'common' }),
  }
}

export interface ProductShotImage {
  imageId: string
  /** 链接拉图时的原始图片地址，上传的图没有。 */
  sourceUrl?: string
  /** 预检认出的画面类型；还没预检或预检失败时为 undefined。 */
  sceneType?: BgSceneType
  /** 旧记录没有这个字段，打开任务时补抠。 */
  sourceMatte?: SourceMatte
  versions: ProductShotVersion[]
  chosenVersionId?: string
}

/** 商品图任务：一组原图连同偏好与版数，作为一个整体跑完。 */
export interface ProductShotJob {
  id: string
  name: string
  images: ProductShotImage[]
  preference: string
  versionsPerImage: number
  /** 最近一次跑的动作，批量沿用；旧记录没有它，由下面两个旧字段读出来。 */
  mode?: ProductShotAction
  /** 最近一次借创意重做的档位，批量沿用。 */
  level?: RemixLevel
  productSource?: LegacyProductSource
  target?: LegacyTarget
  /** 产品素材整任务生效，换产品与借创意重做共用。 */
  productAssets?: ProductAsset[]
  /** 产品说明整任务生效，借创意重做的锁产品段从这里取。 */
  product?: RemixProductDescription
  /** 图上文案的语言，整任务生效；旧记录没有它，按中文读。 */
  language?: PromptLanguage
  createdAt: number
  updatedAt: number
}

export const VERSIONS_PER_IMAGE_CHOICES = [1, 2, 3] as const

export type ProductShotBatchItemState = 'pending' | 'running' | 'done' | 'error'

export function productShotBatchStateLabels(): Record<ProductShotBatchItemState, string> {
  return {
    pending: t('batch.state.pending'),
    running: t('batch.state.running'),
    done: i18next.t('state.done', { ns: 'common' }),
    error: i18next.t('state.failed', { ns: 'common' }),
  }
}

export interface ProductShotBatchItem {
  imageId: string
  state: ProductShotBatchItemState
  error: string | null
}

/** 一轮批量的进度。只活在内存里，刷新后由任务记录里的版本重新算出剩下哪些图。 */
export interface ProductShotBatchProgress {
  items: ProductShotBatchItem[]
  running: boolean
  stopRequested: boolean
  startedAt: number | null
  /** 当前这张走到的那一段，两张之间为 null。 */
  stage: ProductShotStage | null
}
