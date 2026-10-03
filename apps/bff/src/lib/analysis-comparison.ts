import type { AnalysisComparison } from '@image-playground/shared'
import { isObject } from './type-guards'

export function analysisComparison(
  value: unknown,
  imageIds: readonly string[],
): AnalysisComparison | null {
  if (
    !isObject(value) ||
    value.status !== 'completed' ||
    !Array.isArray(value.imageIds) ||
    imageIds.length < 2 ||
    value.imageIds.length !== imageIds.length ||
    new Set(value.imageIds).size !== imageIds.length ||
    !value.imageIds.every((id) => typeof id === 'string' && imageIds.includes(id)) ||
    typeof value.text !== 'string' ||
    !value.text.trim() ||
    value.text.length > 8000
  )
    return null
  return { status: 'completed', imageIds: [...imageIds], text: value.text }
}
