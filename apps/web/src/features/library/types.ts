import type { TaskParams } from '../../types'

/**
 * 素材：给一张已存图片起的名字。图片本体与缩略图仍在 image store 里，
 * 同一个 imageId 可以有多条素材记录。
 */
export interface AssetRecord {
  id: string
  name: string
  imageId: string
  createdAt: number
  lastUsedAt: number
}

/** 模板保存的参数快照。 */
export interface TemplateParams {
  size: string
  quality: TaskParams['quality']
  n: number
}

/**
 * 模板：一段可复用的提示词连同它引用的素材与参数。`prompt` 存带哨兵标记的形式，
 * `assetIds` 按引用序号排列，该序号的参考图不是素材时记 null。
 */
export interface TemplateRecord {
  id: string
  name: string
  prompt: string
  assetIds: Array<string | null>
  params: TemplateParams
  createdAt: number
  lastUsedAt: number
}

/** 排队等取名的一张图；`defaultName` 是空名时回落的名字（新建素材用文件名）。 */
export interface PendingAssetName {
  imageId: string
  defaultName: string
}
