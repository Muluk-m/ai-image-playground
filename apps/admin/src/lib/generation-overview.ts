import { z } from 'zod'
import { parseTimeWindow, type TimeWindow } from '../../contracts'

export const GENERATION_PRESETS = [
  { value: '1h', label: '最近 1 小时', hours: 1 },
  { value: '6h', label: '6 小时', hours: 6 },
  { value: '24h', label: '24 小时', hours: 24 },
  { value: '7d', label: '7 天', hours: 7 * 24 },
  { value: '30d', label: '30 天', hours: 30 * 24 },
] as const

const selectionSchema = z.discriminatedUnion('preset', [
  z.object({ preset: z.enum(['1h', '6h', '24h', '7d', '30d']) }),
  z.object({ preset: z.literal('custom'), from: z.coerce.number(), to: z.coerce.number() }),
])

export type GenerationSelection = z.infer<typeof selectionSchema>
type GenerationSearch = GenerationSelection | { preset?: undefined }
const STORAGE_KEY = 'admin.overview.generation-range'
const DEFAULT_SELECTION: GenerationSelection = { preset: '24h' }

export function parseGenerationSearch(input: unknown): GenerationSearch {
  const parsed = selectionSchema.safeParse(input)
  if (!parsed.success) {
    if (input && typeof input === 'object' && 'preset' in input && input.preset === 'custom')
      throw new Error('自定义范围无效：需要起止时间，且不超过 31 天。')
    return {}
  }
  if (parsed.data.preset === 'custom' && !parseTimeWindow(parsed.data))
    throw new Error('自定义范围无效：需要起止时间，且不超过 31 天。')
  return parsed.data
}

export function readGenerationSelection(): GenerationSelection {
  try {
    const parsed = parseGenerationSearch(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'))
    return parsed.preset ? parsed : DEFAULT_SELECTION
  } catch {
    return DEFAULT_SELECTION
  }
}

export function saveGenerationSelection(selection: GenerationSelection): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selection))
  } catch {
    // 存储被禁用时，URL 仍保留当前筛选。
  }
}

export function generationWindow(selection: GenerationSelection, now = Date.now()): TimeWindow {
  if (selection.preset === 'custom') return { from: selection.from, to: selection.to }
  const hours = GENERATION_PRESETS.find((item) => item.value === selection.preset)?.hours ?? 24
  return { from: now - hours * 3600_000, to: now }
}
