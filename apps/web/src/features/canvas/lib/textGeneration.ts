import { authenticatedBffFetch } from '../../../lib/authClient'
import { getDeviceId } from '../../../lib/deviceId'
import { bffBaseUrl } from '../../../lib/runtimeConfig'

export class TextGenerationError extends Error {
  constructor(message: string) { super(message); this.name = 'TextGenerationError' }
}

export async function generateTextNode(input: {
  model: string
  instruction: string
  currentText: string
  references: readonly { id: string; kind: string; label?: string; text?: string }[]
  signal?: AbortSignal
}): Promise<string> {
  const { signal, ...body } = input
  const response = await authenticatedBffFetch(`${bffBaseUrl()}/api/canvas/text`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({ ...body, deviceId: getDeviceId() }),
  })
  let payload: unknown
  try { payload = await response.json() } catch { throw new TextGenerationError('text_generation_invalid_response') }
  if (!response.ok) {
    let code: unknown
    if (payload && typeof payload === 'object' && 'error' in payload) code = payload.error
    throw new TextGenerationError(typeof code === 'string' ? code : 'text_generation_failed')
  }
  let text: unknown
  if (payload && typeof payload === 'object' && 'text' in payload) text = payload.text
  if (typeof text !== 'string' || !text.trim()) throw new TextGenerationError('text_generation_empty')
  return text
}
