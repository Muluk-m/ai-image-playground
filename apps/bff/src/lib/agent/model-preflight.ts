import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { AGENT_PROFILE_KEYS, type AgentModelSettings } from '@image-playground/shared'
import { isObject } from '../type-guards'
import { agentStreamFn } from './model'
import {
  AgentSettingsError,
  configuredAgentRuntime,
  validateAgentModelSettings,
} from './provider-settings'

const PROBE_CONTEXT: Context = {
  systemPrompt: 'Reply with ok.',
  messages: [{ role: 'user', content: 'ping', timestamp: 0 }],
}

/**
 * 保存前按档位打一次极小请求。相同的供应商、模型和推理强度只打一次。
 * 上游拒绝（含网络失败）就不让保存，避免坏配置进库后每一轮对话都失败。
 */
export async function preflightAgentModelSettings(settings: AgentModelSettings): Promise<void> {
  const seen = new Set<string>()
  for (const key of AGENT_PROFILE_KEYS) {
    const profile = settings.profiles[key]
    const fingerprint = `${profile.providerId}\0${profile.modelId}\0${profile.reasoning}`
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint)
      await probeProfile(settings, key)
    }
  }
}

/** 校验通过才预检。校验失败留给保存自己回报，避免同一条错误被预检提前换成别的文案。 */
export async function preflightAgentModelSave(body: unknown): Promise<void> {
  if (!isObject(body)) return
  let settings: AgentModelSettings
  try {
    settings = validateAgentModelSettings(body.settings)
  } catch (error) {
    if (error instanceof AgentSettingsError) return
    throw error
  }
  await preflightAgentModelSettings(settings)
}

async function probeProfile(
  settings: AgentModelSettings,
  key: (typeof AGENT_PROFILE_KEYS)[number],
): Promise<void> {
  const runtime = configuredAgentRuntime(settings, key === 'default' ? undefined : key)
  let message: AssistantMessage
  try {
    const stream = await agentStreamFn(undefined, {}, runtime)(runtime.model, PROBE_CONTEXT, {
      maxTokens: 1,
      signal: AbortSignal.timeout(20_000),
      reasoning: runtime.effort === 'off' ? undefined : runtime.effort,
    })
    message = await stream.result()
  } catch (error) {
    const detail = error instanceof Error ? error.message : '上游没有响应'
    throw new AgentSettingsError(`档位 ${key} 预检失败：${detail}`)
  }
  if (message.stopReason === 'error' || message.stopReason === 'aborted') {
    throw new AgentSettingsError(
      `档位 ${key} 预检被上游拒绝：${message.errorMessage || '上游没有说明原因'}`,
    )
  }
}
