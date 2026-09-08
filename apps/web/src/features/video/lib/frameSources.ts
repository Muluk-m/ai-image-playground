import type { TaskRecord } from '../../../types'
import type { AssetRecord } from '../../library/types'

/** 可以填进首尾帧的一张图；工作台出图没有名字。 */
export interface FrameSource {
  imageId: string
  name: string
}

const STRIP_LIMIT = 8

export function assetSources(assets: AssetRecord[]): FrameSource[] {
  return [...assets]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .map((asset) => ({ imageId: asset.imageId, name: asset.name }))
}

export function historySources(tasks: TaskRecord[]): FrameSource[] {
  return historyImageIds(tasks).map((imageId) => ({ imageId, name: '' }))
}

/** 素材库在前、出图在后，同一张图只留第一次出现的那条。 */
export function stripSources(assets: AssetRecord[], tasks: TaskRecord[]): FrameSource[] {
  const seen = new Set<string>()
  const strip: FrameSource[] = []

  for (const source of assetSources(assets)) {
    if (seen.has(source.imageId)) continue
    seen.add(source.imageId)
    strip.push(source)
    if (strip.length === STRIP_LIMIT) return strip
  }
  for (const imageId of historyImageIds(tasks)) {
    if (seen.has(imageId)) continue
    seen.add(imageId)
    strip.push({ imageId, name: '' })
    if (strip.length === STRIP_LIMIT) return strip
  }
  return strip
}

function historyImageIds(tasks: TaskRecord[]): string[] {
  return [...tasks]
    .sort((a, b) => b.createdAt - a.createdAt)
    .flatMap((task) => task.outputImages ?? [])
}
