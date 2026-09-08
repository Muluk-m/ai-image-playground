import type { TaskRecord } from '../../../types'
import type { AssetRecord } from '../../library/types'

/** 可以填进首尾帧的一张图。工作台出图没有名字。 */
export interface FrameSource {
  imageId: string
  name: string
}

export function sortedAssets(assets: AssetRecord[]): AssetRecord[] {
  return [...assets].sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

export function historyImageIds(tasks: TaskRecord[]): string[] {
  return [...tasks]
    .sort((a, b) => b.createdAt - a.createdAt)
    .flatMap((task) => task.outputImages ?? [])
}

/** 素材条：素材库在前、出图在后，同一张图只留第一次出现的那条。 */
export function mergeFrameSources(
  assets: AssetRecord[],
  tasks: TaskRecord[],
  limit: number,
): FrameSource[] {
  const sources = [
    ...sortedAssets(assets).map((asset) => ({ imageId: asset.imageId, name: asset.name })),
    ...historyImageIds(tasks).map((imageId) => ({ imageId, name: '' })),
  ]
  const seen = new Set<string>()
  const merged: FrameSource[] = []
  for (const source of sources) {
    if (seen.has(source.imageId)) continue
    seen.add(source.imageId)
    merged.push(source)
    if (merged.length === limit) break
  }
  return merged
}
