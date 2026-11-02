import { INLINE_REASONING_TAGS } from '@image-playground/shared'
import models from './models.config.json'

interface ModelLimits {
  contextWindow: number
  maxTokens: number
}

interface ModelEntry extends ModelLimits {
  /**
   * 这个模型会把推理写在正文开头的哪些标签里（见 `inline-reasoning.ts`）。缺席即不处理：
   * 已经走推理通道的模型不需要，也不该让正文开头恰好是这些标签的回复被当成推理。
   */
  inlineReasoningTags?: readonly string[]
}

const entries: Record<string, ModelEntry> = models

for (const [model, entry] of Object.entries(entries)) {
  const tags = entry.inlineReasoningTags
  if (
    !model.trim() ||
    Object.keys(entry).some(
      (key) => !['contextWindow', 'maxTokens', 'inlineReasoningTags'].includes(key),
    ) ||
    !Number.isSafeInteger(entry.contextWindow) ||
    !Number.isSafeInteger(entry.maxTokens) ||
    entry.maxTokens <= 0 ||
    entry.contextWindow <= entry.maxTokens ||
    (tags !== undefined &&
      (!Array.isArray(tags) ||
        tags.length === 0 ||
        tags.some((tag) => !(INLINE_REASONING_TAGS as readonly string[]).includes(tag))))
  ) {
    throw new Error('Invalid agent model limits configuration')
  }
}

function entryOf(model: string): ModelEntry | undefined {
  return Object.entries(entries).find(([id]) => id === model)?.[1]
}

export function agentModelLimits(model: string): ModelLimits | undefined {
  const entry = entryOf(model)
  return entry ? { contextWindow: entry.contextWindow, maxTokens: entry.maxTokens } : undefined
}

/** 这个模型要从正文开头拆出的推理标签；没配置的模型返回 undefined。 */
export function agentInlineReasoningTags(model: string): readonly string[] | undefined {
  return entryOf(model)?.inlineReasoningTags
}
