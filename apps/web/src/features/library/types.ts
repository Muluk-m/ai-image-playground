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
