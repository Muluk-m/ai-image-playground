import type { AgentBatchAnalysisSource, AgentBatchItem } from '@image-playground/shared'

/** Restore the discriminated protocol after selecting separately typed JSONB columns. */
export function batchItem(row: {
  key: string
  ordinal: number
  kind: AgentBatchItem['kind']
  inputs: AgentBatchItem['inputs']
  prompt: string
  params: AgentBatchItem['params']
  dependencies: AgentBatchItem['dependencies']
  source_analysis?: readonly AgentBatchAnalysisSource[] | null
}): AgentBatchItem {
  const { key, ordinal, inputs, prompt, dependencies } = row
  const common = { key, ordinal, inputs, prompt, dependencies }
  if (row.kind === 'generation' && 'provider' in row.params)
    return {
      ...common,
      kind: 'generation',
      params: row.params,
      ...(row.source_analysis ? { sourceAnalysis: row.source_analysis } : {}),
    }
  if (row.kind === 'analysis' && 'estimatedInputTokens' in row.params)
    return { ...common, kind: 'analysis', params: row.params }
  throw new Error('batch_item_invalid')
}

export function batchItemValues(item: AgentBatchItem) {
  if (item.kind === 'analysis') return { ...item, source_analysis: null }
  const { sourceAnalysis, ...fields } = item
  return { ...fields, source_analysis: sourceAnalysis ?? null }
}
