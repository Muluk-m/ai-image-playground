import type { StreamFn } from '@earendil-works/pi-agent-core'
import { createModels, createProvider, type Model } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { AgentThinkingDepth } from '@image-playground/shared'
import { config } from '../../config'
import { resolveApiKey } from '../resolveApiKey'
import { agentThinking } from './thinking'

const PROVIDER_ID = 'upstream-gateway'

/** pi 要的是完整的 `typeof globalThis.fetch`；测试替身只需要这两个参数。 */
export type AgentFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

let fetchImpl: AgentFetch | undefined

/** 测试注入点；undefined 恢复真实 transport。 */
export function setAgentFetchForTesting(impl?: AgentFetch): void {
  fetchImpl = impl
}

/**
 * 中转网关按 OpenAI Chat Completions 说话，但既不认 `store` 也不认
 * `max_completion_tokens`，与 chatCompletion.ts 打的是同一个上游。
 * `supportsUsageInStreaming` 显式写死：pi 会按 baseUrl 猜兼容性，猜错就没有
 * `stream_options.include_usage`，流式响应也就不带用量，token 计费无从结算。
 */
function gatewayModel(depth?: AgentThinkingDepth): Model<'openai-completions'> {
  return {
    id: agentThinking(depth).model,
    name: agentThinking(depth).model,
    api: 'openai-completions',
    provider: PROVIDER_ID,
    baseUrl: `${config.upstream.baseUrl}/v1`,
    reasoning: !!depth,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.agent.contextWindow,
    maxTokens: config.agent.maxTokens,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      maxTokensField: 'max_tokens',
      supportsUsageInStreaming: true,
    },
  }
}

const runtimes = new Map<string, { model: Model<'openai-completions'>; streamFn: StreamFn }>()

/**
 * 不给 pi 装 telemetry exporter。它的 telemetry 是零依赖契约包，默认 no-op；
 * 装一个就等于把会话内容导给第三方后端。要可观测性走我们自己的 logger。
 */
function runtime(depth?: AgentThinkingDepth) {
  const key = depth ?? 'legacy'
  const cached = runtimes.get(key)
  if (cached) return cached
  const model = gatewayModel(depth)
  const models = createModels()
  models.setProvider(
    createProvider({
      id: PROVIDER_ID,
      name: 'Upstream gateway',
      baseUrl: model.baseUrl,
      auth: {
        apiKey: {
          name: 'Upstream gateway API key',
          resolve: async () => ({ auth: { apiKey: resolveApiKey('openai-compat') } }),
        },
      },
      models: [model],
      api: openAICompletionsApi(),
    }),
  )
  const streamFn: StreamFn = (streamModel, context, options) =>
    models.streamSimple(streamModel, context, {
      ...options,
      fetch: fetchImpl as typeof globalThis.fetch | undefined,
    })
  const result = { model, streamFn }
  runtimes.set(key, result)
  return result
}

export function agentModel(depth?: AgentThinkingDepth): Model<'openai-completions'> {
  return runtime(depth).model
}

export function agentStreamFn(depth?: AgentThinkingDepth): StreamFn {
  return runtime(depth).streamFn
}
