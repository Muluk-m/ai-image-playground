import { getActiveApiProfile } from './apiProfiles'
import { getPublicChannel } from './channels/publicChannels'
import { callQueueChannelApi, resumeQueueChannelApi, toQueueProvider } from './channels/queueClient'
import type { UserByokProfile } from './channels/types'
import { callGeminiImageApi } from './geminiImageApi'
import type { BYOKAdapterProfile, CallApiOptions, CallApiResult } from './imageApiShared'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'

export { normalizeBaseUrl } from './devProxy'
export type { CallApiOptions, CallApiResult } from './imageApiShared'

function toByokAdapterProfile(profile: UserByokProfile): BYOKAdapterProfile {
  return {
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.selectedModelId,
    apiMode: profile.preferences.apiMode,
    timeout: profile.preferences.timeout,
    codexCli: profile.preferences.codexCli,
    apiProxy: profile.preferences.apiProxy,
    responseFormatB64Json: profile.preferences.responseFormatB64Json,
  }
}

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)

  if (profile.source === 'builtin-edge') {
    const channel = getPublicChannel(profile.channelId)
    if (!channel) throw new Error(`找不到内置 channel：${profile.channelId}`)
    // builtin-edge 全部走 queue：浏览器 → BFF 都是 < 1s 短请求，永远绕开 CF Edge
    // ~60s 死线。生成 / 编辑 / mask 编辑都靠 BFF worker 调上游 /v1/images/edits
    // 或 /v1/images/generations 区分。
    if (toQueueProvider(channel.kind) === null) {
      throw new Error(`不支持的内置 channel kind：${channel.kind}`)
    }
    return callQueueChannelApi(opts, profile, channel)
  }

  // user-byok
  const byok = toByokAdapterProfile(profile)
  switch (profile.kind) {
    case 'gemini':
      return callGeminiImageApi(opts, byok)
    case 'openai-compat':
    case 'http-template':
      // http-template 暂走 OpenAI 兼容路径；未来若新增独立 adapter 在此分支替换。
      return callOpenAICompatibleImageApi(opts, byok, null)
    case 'openai-queue':
    case 'gemini-queue':
      throw new Error(
        `queue kind ${profile.kind} 仅用于 builtin-edge profile，不应作为 user-byok kind`,
      )
  }
}

/**
 * 刷新页面后用持久化的 bffRequestId 继续轮询。仅适用于 builtin-edge queue 路径。
 * 找不到对应 channel/profile 时抛错，由调用方写到 task.error。
 */
export async function resumeQueueImageApi(
  opts: CallApiOptions,
  requestId: string,
): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)
  if (profile.source !== 'builtin-edge') {
    throw new Error('恢复 BFF queue 任务时未找到对应内置 channel profile')
  }
  const channel = getPublicChannel(profile.channelId)
  if (!channel) throw new Error(`找不到内置 channel：${profile.channelId}`)
  if (toQueueProvider(channel.kind) === null) {
    throw new Error(`channel kind ${channel.kind} 非 queue，无法恢复`)
  }
  return resumeQueueChannelApi(opts, profile, channel, requestId)
}
