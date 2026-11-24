import type { GptDirectAdminView } from '@image-playground/shared'
import { refreshGptDirectKeys } from './gpt-direct-admin'
import { buildDirectKeyPanel } from './gpt-keys'

export async function directKeyPanel(days: 7 | 30, now = Date.now()): Promise<GptDirectAdminView> {
  await refreshGptDirectKeys()
  return buildDirectKeyPanel(days, now)
}
