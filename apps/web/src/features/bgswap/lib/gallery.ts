import { type ExportEntry, type ExportFit, sanitizePathSegment } from '../../../lib/imageExport'
import type { TaskRecord } from '../../../types'
import type { BgSwapImage, BgSwapVersion } from '../types'
import { type VersionState, versionProgress } from './versionProgress'

export interface GalleryVersion {
  version: BgSwapVersion
  /** 这一版的原图，看蒙版时要把预览盖回它上面。 */
  imageId: string
  /** 原图在任务里的序号，导出文件名用它。 */
  imageIndex: number
  versionIndex: number
  state: VersionState
  outputImageIds: string[]
  chosen: boolean
}

export interface GalleryRow {
  imageId: string
  imageIndex: number
  versions: GalleryVersion[]
}

export const EXPORT_SCOPES = ['chosen', 'all'] as const
export type ExportScope = (typeof EXPORT_SCOPES)[number]
export const EXPORT_SCOPE_LABELS: Record<ExportScope, string> = { chosen: '选用版', all: '全部版' }

/** 出过版本的原图才进总览，一张一行。 */
export function galleryRows(
  images: readonly BgSwapImage[],
  tasksById: ReadonlyMap<string, TaskRecord>,
): GalleryRow[] {
  return images.flatMap((image, imageIndex) =>
    image.versions.length === 0
      ? []
      : [
          {
            imageId: image.imageId,
            imageIndex,
            versions: image.versions.map((version, versionIndex) => {
              const progress = versionProgress(tasksById.get(version.taskId))
              return {
                version,
                imageId: image.imageId,
                imageIndex,
                versionIndex,
                state: progress.state,
                outputImageIds: progress.outputImageIds,
                chosen: image.chosenVersionId === version.id,
              }
            }),
          },
        ],
  )
}

export function flatVersions(rows: readonly GalleryRow[]): GalleryVersion[] {
  return rows.flatMap((row) => row.versions)
}

export interface ManualExportScope {
  scope: ExportScope
  /** 切换那一刻有没有选用版本。 */
  hasChosen: boolean
}

export function hasChosenVersion(rows: readonly GalleryRow[]): boolean {
  return rows.some((row) => row.versions.some((item) => item.chosen))
}

/** 手动值只在选用状态没变时算数，用户选定或撤销一版之后重新落回默认。 */
export function resolveExportScope(
  hasChosen: boolean,
  manual: ManualExportScope | null,
): ExportScope {
  if (manual && manual.hasChosen === hasChosen) return manual.scope
  return hasChosen ? 'chosen' : 'all'
}

export function exportBlockedReason(
  scope: ExportScope,
  hasChosen: boolean,
  count: number,
): string | null {
  if (count > 0) return null
  return scope === 'chosen' && !hasChosen ? '未选用版本' : '暂无成图'
}

export function bgSwapFileName(imageIndex: number, versionIndex: number, imageOffset = 0): string {
  const order = String(imageIndex + 1).padStart(2, '0')
  const suffix = imageOffset > 0 ? `-${imageOffset + 1}` : ''
  return `${order}-v${versionIndex + 1}${suffix}.png`
}

export function bgSwapEntryName(
  jobName: string,
  imageIndex: number,
  versionIndex: number,
  imageOffset = 0,
): string {
  return `${sanitizePathSegment(jobName)}/${bgSwapFileName(imageIndex, versionIndex, imageOffset)}`
}

export interface ExportPlan {
  entries: ExportEntry[]
  /** 范围内还没出图的版本数：失败的、排队的、正在跑的都算，打包时跳过。 */
  skipped: number
}

export function exportPlan(
  jobName: string,
  rows: readonly GalleryRow[],
  scope: ExportScope,
  fit: ExportFit,
): ExportPlan {
  const inScope = flatVersions(rows).filter((item) => scope === 'all' || item.chosen)
  return {
    entries: inScope.flatMap((item) =>
      item.outputImageIds.map((imageId, imageOffset) => ({
        path: bgSwapEntryName(jobName, item.imageIndex, item.versionIndex, imageOffset),
        imageId,
        fit,
      })),
    ),
    skipped: inScope.filter((item) => item.outputImageIds.length === 0).length,
  }
}
