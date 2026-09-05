/** 平台导出尺寸。`id` 与套的 platform 同名，选了平台就定了默认导出尺寸。 */
export interface ExportPreset {
  readonly id: string
  readonly label: string
  readonly width: number
  readonly height: number
}

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  { id: 'amazon', label: '亚马逊 2000×2000', width: 2000, height: 2000 },
  { id: 'alibaba', label: '阿里巴巴 800×800', width: 800, height: 800 },
  { id: 'pinduoduo', label: '拼多多 750×1000', width: 750, height: 1000 },
  { id: 'site', label: '独立站 1200×1200', width: 1200, height: 1200 },
]

export function findExportPreset(id: string): ExportPreset | null {
  return EXPORT_PRESETS.find((preset) => preset.id === id) ?? null
}
