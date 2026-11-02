import { authenticatedBffFetch } from '../../../lib/authClient'
import { bffBaseUrl } from '../../../lib/runtimeConfig'

export interface TextChatModel {
  readonly id: string
  readonly model: string
  readonly label: string
}

export async function fetchTextChatModels(signal?: AbortSignal): Promise<{
  models: readonly TextChatModel[]
  defaultModel: string | null
}> {
  const response = await authenticatedBffFetch(`${bffBaseUrl()}/api/canvas/text/models`, {
    signal,
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('text_generation_models_failed')
  const payload: unknown = await response.json()
  if (!payload || typeof payload !== 'object' || !('models' in payload))
    throw new Error('text_generation_models_invalid')
  const raw = payload.models
  const models = Array.isArray(raw)
    ? raw
        .filter(
          (model): model is { id: string; label: string; model?: string } =>
            Boolean(model) &&
            typeof model === 'object' &&
            'id' in model &&
            typeof model.id === 'string' &&
            'label' in model &&
            typeof model.label === 'string' &&
            (!('model' in model) || typeof model.model === 'string'),
        )
        .map((model) => ({
          ...model,
          model: model.model ?? model.id.split('::').pop() ?? model.id,
        }))
    : []
  const defaultModel =
    'defaultModel' in payload && typeof payload.defaultModel === 'string'
      ? payload.defaultModel
      : null
  return { models, defaultModel }
}
