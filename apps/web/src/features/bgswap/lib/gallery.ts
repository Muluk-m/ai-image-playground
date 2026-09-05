import type { ExportEntry, ExportFit } from '../../../lib/imageExport'
import { sanitizePathSegment } from '../../../lib/imageExport'
import type { TaskRecord } from '../../../types'
import type { BgSwapImage, BgSwapVersion } from '../types'
import { type VersionState, versionProgress } from './versionProgress'

export interface GalleryVersion {
  version: BgSwapVersion
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

export function exportEntries(
  jobName: string,
  rows: readonly GalleryRow[],
  scope: ExportScope,
  fit: ExportFit,
): ExportEntry[] {
  return flatVersions(rows)
    .filter((item) => scope === 'all' || item.chosen)
    .flatMap((item) =>
      item.outputImageIds.map((imageId, imageOffset) => ({
        path: bgSwapEntryName(jobName, item.imageIndex, item.versionIndex, imageOffset),
        imageId,
        fit,
      })),
    )
}
