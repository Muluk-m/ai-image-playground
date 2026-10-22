import type { StreamFn } from '@earendil-works/pi-agent-core'
import {
  type AssistantMessage,
  createModels,
  createProvider,
  type Model,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import type { AgentThinkingDepth } from '@image-playground/shared'
import { config } from '../../config'
import { log } from '../logger'
import { resolveChatApiKey } from '../resolveApiKey'
import { withInlineReasoning } from './inline-reasoning'
import { agentInlineReasoningTags } from './model-limits'
import { type AgentDispatchObserver, guardedAgentFetch } from './outbound-budget'
import { observeOverloadResponse } from './overload-response'
import { providerFetch } from './provider-fetch'
import type { ConfiguredAgentRuntime } from './provider-settings'
import { requestInputTokens } from './request-budget'
import { AGENT_STREAM_IDLE_TIMEOUT_MS, withIdleTimeout } from './stream-idle'
import { retryOverloadedStream } from './stream-retry'
import { agentThinking } from './thinking'

const PROVIDER_ID = 'upstream-gateway'

/** pi 要的是完整的 `typeof globalThis.fetch`；测试替身只需要这两个参数。 */
export type AgentFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

let fetchImpl: AgentFetch | undefined
let idleMs = AGENT_STREAM_IDLE_TIMEOUT_MS
let retryBackoffMs = 1000

export function setAgentRetryBackoffForTesting(ms?: number): void {
  retryBackoffMs = ms ?? 1000
}

/** 测试注入点；undefined 恢复真实 transport。 */
export function setAgentFetchForTesting(impl?: AgentFetch): void {
  fetchImpl = impl
}

/** 测试注入点：把空闲看门狗调短；undefined 恢复默认。 */
export function setAgentStreamIdleForTesting(ms?: number): void {
  idleMs = ms ?? AGENT_STREAM_IDLE_TIMEOUT_MS
}

/**
 * 中转网关按 OpenAI Chat Completions 说话，但既不认 `store` 也不认
 * `max_completion_tokens`，与 chatCompletion.ts 打的是同一个上游。
 * `supportsUsageInStreaming` 显式写死：pi 会按 baseUrl 猜兼容性，猜错就没有
 * `stream_options.include_usage`，流式响应也就不带用量，token 计费无从结算。
 */
function gatewayModel(depth?: AgentThinkingDepth): Model<'openai-completions'> {
  const profile = agentThinking(depth)
  return {
    id: profile.model,
    name: profile.model,
    api: 'openai-completions',
    provider: PROVIDER_ID,
    baseUrl: `${config.upstream.baseUrl}/v1`,
    reasoning: !!depth,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // 当前档位配置的预算窗口；压缩、硬闸和预扣都从这里读同一个值。
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxTokens,
    compat: {
      supportsStore: false,
      supportsReasoningEffort: true,
      maxTokensField: 'max_tokens',
      supportsUsageInStreaming: true,
      // 与 Pi 0.87 的未知兼容网关默认值对齐；不让 URL 启发式替网关承诺 strict schema。
      supportsStrictMode: false,
    },
  }
}

const runtimes = new Map<
  string,
  { model: Model<'openai-completions'>; models: ReturnType<typeof createModels> }
>()

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
          resolve: async () => ({ auth: { apiKey: resolveChatApiKey(model.id) } }),
        },
      },
      models: [model],
      api: openAICompletionsApi(),
    }),
  )
  const result = { model, models }
  runtimes.set(key, result)
  return result
}

export function agentModel(depth?: AgentThinkingDepth): Model<'openai-completions'> {
  return runtime(depth).model
}

export function agentStreamFn(
  depth?: AgentThinkingDepth,
  observer: AgentDispatchObserver & {
    onRetry?: (message: AssistantMessage, nextModelId: string) => Promise<void>
  } = {},
  selectedRuntime?: ConfiguredAgentRuntime,
): StreamFn {
  const transport = fetchImpl ?? globalThis.fetch
  // 过载判断要读这一次 fetch 看到的响应。主模型和备用模型各开一条流，共用这一个槽。
  const slot: { rejected: () => boolean } = { rejected: () => false }
  const bind = (
    selected: Pick<ConfiguredAgentRuntime, 'model' | 'models' | 'trustedGateway'> | undefined,
  ): StreamFn => {
    const { models } = selected ?? runtime(depth)
    return (streamModel, context, options) => {
      let rejection: ReturnType<typeof observeOverloadResponse> | undefined
      const guarded = guardedAgentFetch(async (input, init) => {
        const response = await transport(input, init)
        rejection = observeOverloadResponse(response)
        return rejection.response
      }, observer)
      const outbound =
        selected && !selected.trustedGateway
          ? providerFetch(guarded, selected.model.baseUrl)
          : guarded
      slot.rejected = () => {
        const overloaded = rejection?.isRejected() ?? false
        if (overloaded)
          log.warn(
            {
              event: 'agent.upstream_overload',
              model: streamModel.id,
              httpStatus: rejection?.response.status,
            },
            'upstream explicitly rejected model request due to overload',
          )
        return overloaded
      }
      const stream = models.streamSimple(streamModel, context, {
        ...options,
        maxRetries: 0,
        fetch: withIdleTimeout(outbound, idleMs) as typeof globalThis.fetch,
      })
      // 把推理写在正文开头标签里的模型，在这一层就拆成 thinking：正文、落库与原生历史都不带标签。
      const tags = agentInlineReasoningTags(streamModel.id)
      return tags ? withInlineReasoning(stream, tags, streamModel) : stream
    }
  }
  const fallback = selectedRuntime?.fallback
  return (model, context, options) =>
    retryOverloadedStream(
      bind(selectedRuntime),
      () => slot.rejected(),
      observer.onRetry,
      retryBackoffMs,
      fallback
        ? {
            model: fallback.model,
            stream: bind(fallback),
            reasoning: fallback.effort === 'off' ? undefined : fallback.effort,
            fits: (request) =>
              requestInputTokens(request) <=
              fallback.model.contextWindow - fallback.model.maxTokens,
          }
        : undefined,
    )(model, context, options)
}
