import type {
  ASSET_BACKGROUNDS,
  ASSET_KINDS,
  ASSET_VIEW_LABELS,
  ASSET_VIEW_SOURCES,
  LOOK_PURPOSES,
} from '@image-playground/shared'
import type { TaskParams } from '../../types'

export { lookSkillName } from '@image-playground/shared'

/** 素材的类别：产品或人物。`views` 之前建的素材没有类别，仍是普通参考图。 */
export type AssetKind = (typeof ASSET_KINDS)[number]
/** 背景状态。透明只在生成它的模型原生支持透明输出时才有，不承诺抠图。 */
export type AssetBackground = (typeof ASSET_BACKGROUNDS)[number]
export type AssetViewLabel = (typeof ASSET_VIEW_LABELS)[number]
export type AssetViewSource = (typeof ASSET_VIEW_SOURCES)[number]

/** 视角：素材里的一张图及它的视角标签与来源。正侧背拼在一张里的仍是一张视角图，标 `sheet`。 */
export interface AssetView {
  imageId: string
  label: AssetViewLabel
  source: AssetViewSource
}

/**
 * 素材：同一个主体的一组图，起一个名字。图片本体与缩略图仍在 image store 里，
 * 同一个 imageId 可以出现在多条素材里。`views` 有序且至少一条，第一条是封面。
 */
export interface AssetRecord {
  id: string
  name: string
  kind?: AssetKind
  background?: AssetBackground
  views: AssetView[]
  createdAt: number
  /** 内容最后一次改动的时间。「使用」只动 `lastUsedAt`，不动这里。 */
  updatedAt: number
  lastUsedAt: number
}

/** 封面：第一条视角的图片。组里至少有一条视角，所以它永远有值。 */
export function assetCoverImageId(asset: AssetRecord): string {
  return asset.views[0]?.imageId ?? ''
}

/** 墓碑：删掉的记录在表里留下的这一行，只有 id 与时间戳。所有读路径都要过滤掉它。 */
export interface Tombstone {
  id: string
  updatedAt: number
  deletedAt: number
}

/** 模板保存的参数快照。 */
export interface TemplateParams {
  size: string
  quality: TaskParams['quality']
  n: number
}

/**
 * 已存提示词：一段可复用的提示词连同它引用的素材与参数（界面上叫「提示词」，
 * 存储名与同步 kind 仍是 `templates`）。`prompt` 存带哨兵标记的形式，
 * `assetIds` 按引用序号排列，该序号的参考图不是素材时记 null。
 */
export interface TemplateRecord {
  id: string
  name: string
  prompt: string
  assetIds: Array<string | null>
  params: TemplateParams
  createdAt: number
  /** 内容最后一次改动的时间。「套用」只动 `lastUsedAt`，不动这里。 */
  updatedAt: number
  lastUsedAt: number
}

/** 模板的用途：主图 / 海报 / 场景图 / 详情图。 */
export type LookPurpose = (typeof LOOK_PURPOSES)[number]

/**
 * 模板（界面文案是「模板」，代码里叫 `look`，因为旧「模板」占着 `templates`）：
 * 一个调好的出图效果。它的形态就是一份技能——`body` 是 frontmatter 之后的分节正文，
 * 其余字段就是 frontmatter。钉死的模型下线时界面标「需重新调试」，不自动换模型。
 */
export interface LookRecord {
  id: string
  name: string
  /** 一句话描述。它进这个用户每一轮的技能清单。 */
  description: string
  purpose: LookPurpose
  body: string
  model: string
  size: string
  /** 素材位数量：出图时要几个素材填上。 */
  slotCount: number
  referenceImageIds: string[]
  coverImageId: string | null
  createdAt: number
  /** 内容最后一次改动的时间。「用它出图」只动 `lastUsedAt`，不动这里。 */
  updatedAt: number
  lastUsedAt: number
}

/** 排队等取名的一张图；`defaultName` 是空名时回落的名字（新建素材用文件名）。 */
export interface PendingAssetName {
  imageId: string
  defaultName: string
  /** 取名保存后回调，让发起导入的一方接手这条新素材。 */
  onSaved?: (asset: AssetRecord) => void
}
