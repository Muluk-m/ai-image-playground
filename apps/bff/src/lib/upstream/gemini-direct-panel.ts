import type { GeminiDirectAdminView } from '@image-playground/shared'
import { refreshUpstreamSecrets } from '../upstream-secrets'
import { refreshGeminiDirectKeys } from './gemini-direct-admin'
import { buildGeminiDirectKeyPanel, restoreGeminiDirectKey } from './gemini-keys'

async function syncGeminiKeySources(): Promise<void> {
  await refreshUpstreamSecrets().catch(() => {})
  await refreshGeminiDirectKeys().catch(() => {})
}

export async function geminiDirectPanel(days: 7 | 30): Promise<GeminiDirectAdminView> {
  await syncGeminiKeySources()
  return buildGeminiDirectKeyPanel(days)
}

export async function restoreGeminiDirectKeyAfterSync(
  fingerprint: string,
  operator?: string,
): Promise<boolean> {
  await syncGeminiKeySources()
  return restoreGeminiDirectKey(fingerprint, operator)
}
