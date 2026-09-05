import type { ExportPreset, ShotType } from '@image-playground/shared'
import {
  CENTER_OFFSET,
  type CropOffset,
  downloadExportedImage,
  downloadExportZip,
  type ExportFit,
  type ExportResult,
} from '../../../lib/imageExport'
import { exportEntryName, exportFileName } from './exportPresets'

export interface SetExportShot {
  shotIndex: number
  shotType: ShotType
  imageIds: readonly string[]
  fit: ExportFit
}

export async function downloadShotImage(
  shot: SetExportShot,
  imageId: string,
  preset: ExportPreset,
  offset: CropOffset = CENTER_OFFSET,
): Promise<void> {
  const imageIndex = Math.max(0, shot.imageIds.indexOf(imageId))
  await downloadExportedImage(
    exportFileName(shot.shotIndex, shot.shotType, imageIndex),
    imageId,
    shot.fit,
    preset,
    offset,
  )
}

export async function downloadSetZip(
  setName: string,
  shots: readonly SetExportShot[],
  preset: ExportPreset,
  offset: CropOffset = CENTER_OFFSET,
): Promise<ExportResult> {
  const entries = shots.flatMap((shot) =>
    shot.imageIds.map((imageId, imageIndex) => ({
      path: exportEntryName(setName, shot.shotIndex, shot.shotType, imageIndex),
      imageId,
      fit: shot.fit,
    })),
  )
  return downloadExportZip(setName, entries, preset, offset)
}
