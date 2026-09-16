import type { ExportPreset } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { type ExportEntry, type ExportFit, sanitizePathSegment } from '../../../lib/imageExport'
import type { TaskRecord } from '../../../types'
import type { ProductShotImage, ProductShotVersion } from '../types'
import { renderKitImage } from '../workflows/render'
import { type VersionState, versionProgress } from './versionProgress'

export interface GalleryVersion {
  version: ProductShotVersion
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
export function exportScopeLabels(): Record<ExportScope, string> {
  return {
    chosen: i18next.t('gallery.scope.chosen', { ns: 'productShots' }),
    all: i18next.t('gallery.scope.all', { ns: 'productShots' }),
  }
}

/**
 * 导出尺寸的界面标签。`packages/shared` 那份 `label` 是中文常量，界面按 preset id 查译文，
 * 尺寸数字写在译文里。`ExportPreset.id` 是 string，拼不出 i18next 要的字面量 key，显式列一遍。
 */
export function exportPresetLabels(): Record<string, string> {
  return {
    amazon: i18next.t('exportPreset.amazon', { ns: 'productShots' }),
    alibaba: i18next.t('exportPreset.alibaba', { ns: 'productShots' }),
    pinduoduo: i18next.t('exportPreset.pinduoduo', { ns: 'productShots' }),
    site: i18next.t('exportPreset.site', { ns: 'productShots' }),
  }
}

export function exportPresetLabel(preset: ExportPreset): string {
  return exportPresetLabels()[preset.id] ?? ''
}

/** 出过版本的原图才进总览，一张一行。 */
export function galleryRows(
  images: readonly ProductShotImage[],
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

/** 大图查看器的翻页范围：总览里所有成图，按卡片顺序。 */
export function galleryImageIds(rows: readonly GalleryRow[]): string[] {
  return flatVersions(rows).flatMap((item) => item.outputImageIds)
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
  return scope === 'chosen' && !hasChosen
    ? i18next.t('gallery.blocked.notChosen', { ns: 'productShots' })
    : i18next.t('gallery.blocked.empty', { ns: 'productShots' })
}

export function shotFileName(imageIndex: number, versionIndex: number, imageOffset = 0): string {
  const order = String(imageIndex + 1).padStart(2, '0')
  const suffix = imageOffset > 0 ? `-${imageOffset + 1}` : ''
  return `${order}-v${versionIndex + 1}${suffix}.png`
}

export function shotEntryName(
  jobName: string,
  imageIndex: number,
  versionIndex: number,
  imageOffset = 0,
): string {
  return `${sanitizePathSegment(jobName)}/${shotFileName(imageIndex, versionIndex, imageOffset)}`
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
        path: shotEntryName(jobName, item.imageIndex, item.versionIndex, imageOffset),
        imageId,
        fit,
        ...(item.version.workflow?.spec.kind === 'kit'
          ? { render: () => renderKitImage(imageId, item.version) }
          : {}),
      })),
    ),
    skipped: inScope.filter((item) => item.outputImageIds.length === 0).length,
  }
}
