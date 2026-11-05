import type { QueueProvider } from '@image-playground/shared'
import { config } from '../config'
import { runtimeSecret } from './upstream-secret-cache'

/**
 * 网关密钥。后台记录只替换通用的 UPSTREAM_API_KEY。
 * 供应商专用环境变量仍优先，和部署说明一致。
 */
export function resolveApiKey(kind: QueueProvider): string {
  const { apiKey, openaiApiKey, geminiApiKey } = config.upstream
  const generic = runtimeSecret('UPSTREAM_API_KEY', apiKey)
  if (kind === 'openai-compat') return openaiApiKey || generic
  if (kind === 'gemini') return geminiApiKey || generic
  return generic
}

/** Chat, summary and search calls prefer the Claude credential when configured. */
export function resolveChatApiKey(model: string): string {
  if (!model.toLowerCase().startsWith('claude-')) return resolveApiKey('openai-compat')
  return config.upstream.claudeApiKey || resolveApiKey('openai-compat')
}
