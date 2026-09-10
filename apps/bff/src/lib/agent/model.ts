import type { StreamFn } from '@earendil-works/pi-agent-core'
import { createModels, createProvider, type Model } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { config } from '../../config'
import { resolveApiKey } from '../resolveApiKey'

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
 */
function gatewayModel(): Model<'openai-completions'> {
  return {
    id: config.agent.model,
    name: config.agent.model,
    api: 'openai-completions',
    provider: PROVIDER_ID,
    baseUrl: `${config.upstream.baseUrl}/v1`,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.agent.contextWindow,
    maxTokens: config.agent.maxTokens,
    compat: { supportsStore: false, maxTokensField: 'max_tokens' },
  }
}

let cached: { model: Model<'openai-completions'>; streamFn: StreamFn } | undefined

function runtime() {
  if (cached) return cached
  const model = gatewayModel()
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
  cached = { model, streamFn }
  return cached
}

export function agentModel(): Model<'openai-completions'> {
  return runtime().model
}

export function agentStreamFn(): StreamFn {
  return runtime().streamFn
}
