import type { UserByokProfile } from './channels/types'
import { callEdgeChannelApi } from './channels/edgeClient'
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
  }
}
