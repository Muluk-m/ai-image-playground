import type { UserByokProfile } from './channels/types'
import { callEdgeChannelApi } from './channels/edgeClient'
import { callQueueChannelApi, toQueueProvider } from './channels/queueClient'
import { getPublicChannel } from './channels/publicChannels'
import { getActiveApiProfile } from './apiProfiles'
import { callGeminiImageApi } from './geminiImageApi'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import type { BYOKAdapterProfile, CallApiOptions, CallApiResult } from './imageApiShared'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

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
    // builtin-edge 默认全部走 queue（浏览器 → BFF 全是 < 1s 短请求，永远绕开
    // CF Edge 100s）。OpenAI mask 编辑因为是 multipart FormData，queue 协议
    // 还没覆盖，回退到 /api-proxy/ 同步路径（mask edit 通常 < 30s，少踩 100s）。
    if (opts.maskDataUrl) {
      return callEdgeChannelApi(opts, profile, channel)
    }
    if (toQueueProvider(channel.kind) !== null) {
      return callQueueChannelApi(opts, profile, channel)
    }
    return callEdgeChannelApi(opts, profile, channel)
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
      throw new Error(`queue kind ${profile.kind} 仅用于 builtin-edge profile，不应作为 user-byok kind`)
  }
}
