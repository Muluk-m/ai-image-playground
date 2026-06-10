import { config } from '../config'

/** Pick the upstream API key for a given provider kind, falling back to the generic key. */
export function resolveApiKey(kind: string): string {
  const { apiKey, openaiApiKey, geminiApiKey, agnesApiKey } = config.upstream
  if (kind === 'openai-compat') return openaiApiKey || apiKey
  if (kind === 'gemini') return geminiApiKey || apiKey
  if (kind === 'agnes') return agnesApiKey || apiKey
  return apiKey
}
