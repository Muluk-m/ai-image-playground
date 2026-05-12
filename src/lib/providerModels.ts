import type { ApiProvider } from '../types'

/**
 * 各服务商类型的官方/常用模型 ID 候选清单。
 *
 * 这是「服务商类型」层面的全局选项，与单个 ApiProfile 的可见模型范围
 * （profile.models）正交：
 *
 * - 这里的列表用于 profile 编辑 UI 中 model 字段的下拉建议。
 * - profile.models（用户在编辑界面勾选的子集）决定主界面 InputBar 上的快选范围。
 */
export const PROVIDER_MODEL_OPTIONS: Record<string, string[]> = {
  openai: ['gpt-image-2', 'gpt-image-1', 'dall-e-3'],
  fal: ['openai/gpt-image-2'],
  gemini: [
    'gemini-3.1-flash-image',
    'gemini-3.1-flash-image-preview',
    'gemini-2.5-flash-image',
  ],
}

export function getProviderModelOptions(provider: ApiProvider): string[] {
  return PROVIDER_MODEL_OPTIONS[provider] ?? []
}
