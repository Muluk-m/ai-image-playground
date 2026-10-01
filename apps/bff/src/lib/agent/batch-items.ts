import type { AgentBatchItem } from '@image-playground/shared'

/** Restore the discriminated protocol after selecting separately typed JSONB columns. */
export function batchItem(row: {
  key: string
  ordinal: number
  kind: AgentBatchItem['kind']
  inputs: AgentBatchItem['inputs']
  prompt: string
  params: AgentBatchItem['params']
  dependencies: AgentBatchItem['dependencies']
}): AgentBatchItem {
  const { key, ordinal, inputs, prompt, dependencies } = row
  const common = { key, ordinal, inputs, prompt, dependencies }
  if (row.kind === 'generation' && 'provider' in row.params)
    return { ...common, kind: 'generation', params: row.params }
  if (row.kind === 'analysis' && 'estimatedInputTokens' in row.params)
    return { ...common, kind: 'analysis', params: row.params }
  throw new Error('batch_item_invalid')
}
