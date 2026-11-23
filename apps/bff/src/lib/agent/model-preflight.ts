import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import {
  AGENT_PROFILE_KEYS,
  type AgentModelProbeResult,
  type AgentModelSettings,
  type AgentProfileKey,
} from '@image-playground/shared'
import { resolveChatApiKey } from '../resolveApiKey'
import { isObject } from '../type-guards'
import { agentStreamFn } from './model'
import {
  AgentSettingsError,
  configuredAgentRuntime,
  providerCredentialReady,
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

/**
 * 后台按档位手动探测单次连通性（1 token）。不回传原始网络错误或上游地址，防止内网端点或凭证信息外泄。
 */
export async function probeAgentModelBinding(body: unknown): Promise<AgentModelProbeResult> {
  if (!isObject(body)) throw new AgentSettingsError('探测请求无效')
  const profileKey = body.profile
  if (
    typeof profileKey !== 'string' ||
    !AGENT_PROFILE_KEYS.includes(profileKey as AgentProfileKey)
  ) {
    throw new AgentSettingsError('未知档位')
  }
  const target = body.target === 'fallback' ? 'fallback' : 'primary'
  if (
    !isObject(body.settings) ||
    !Array.isArray(body.settings.providers) ||
    !isObject(body.settings.profiles)
  ) {
    throw new AgentSettingsError('模型设置无效')
  }
  const rawProfile = body.settings.profiles[profileKey]
  if (!isObject(rawProfile)) throw new AgentSettingsError(`缺少 ${profileKey} 档位`)
  const rawBinding = target === 'fallback' ? rawProfile.fallback : rawProfile
  if (target === 'fallback' && rawBinding === undefined) {
    return { ok: false, status: 'unconfigured', latencyMs: 0, message: '未配置备用路由' }
  }
  if (!isObject(rawBinding) || typeof rawBinding.providerId !== 'string') {
    throw new AgentSettingsError('路由绑定无效')
  }
  const rawProvider = body.settings.providers.find(
    (item) => isObject(item) && item.id === rawBinding.providerId,
  )
  if (!rawProvider) throw new AgentSettingsError('所选 Provider 不存在')

  const singleBinding = {
    providerId: rawBinding.providerId,
    modelId: rawBinding.modelId,
    reasoning: rawBinding.reasoning,
  }
  const isolatedSettings = validateAgentModelSettings({
    providers: [rawProvider],
    profiles: Object.fromEntries(AGENT_PROFILE_KEYS.map((key) => [key, singleBinding])),
  })
  const provider = isolatedSettings.providers[0]!
  const providerReady =
    provider.id === 'upstream-gateway' && !provider.secretRef
      ? Boolean(resolveChatApiKey(isolatedSettings.profiles[profileKey as AgentProfileKey].modelId))
      : providerCredentialReady(provider)
  if (!providerReady) {
    return {
      ok: false,
      status: 'unconfigured',
      latencyMs: 0,
      message: '服务端尚未配置该 Provider 的密钥',
    }
  }
  const startedAt = performance.now()
  try {
    const key = profileKey as AgentProfileKey
    const runtime = configuredAgentRuntime(isolatedSettings, key === 'default' ? undefined : key)
    // 超时控制在 10s，低于 Admin -> BFF 内部代理的 15s 上限，确保返回结构化诊断而非代理 500。
    const stream = await agentStreamFn(undefined, {}, runtime)(runtime.model, PROBE_CONTEXT, {
      maxTokens: 1,
      signal: AbortSignal.timeout(10_000),
      reasoning: runtime.effort === 'off' ? undefined : runtime.effort,
    })
    const message = await stream.result()
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt))
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      return { ok: false, status: 'failed', latencyMs, message: '上游拒绝了探测请求' }
    }
    return { ok: true, status: 'ok', latencyMs }
  } catch {
    const latencyMs = Math.max(1, Math.round(performance.now() - startedAt))
    return { ok: false, status: 'failed', latencyMs, message: '连接失败或响应超时' }
  }
}

async function probeProfile(
  settings: AgentModelSettings,
  key: (typeof AGENT_PROFILE_KEYS)[number],
): Promise<void> {
  const profile = settings.profiles[key]
  const provider = settings.providers.find((item) => item.id === profile.providerId)
  // 密钥还没配时打不了预检。保存仍然允许，真正调用时再拒绝，也不会去借网关的密钥。
  if (!provider || !providerCredentialReady(provider)) return
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
