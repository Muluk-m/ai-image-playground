import type {
  AgentImageActionStep,
  AgentPanelMessage,
  AgentTextMessage,
  AgentTurnFooter,
} from '../types'
import type { AgentPanelState } from './panelMessages'

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** Cache data is untrusted. Rebuild a small display model, never restore nested tool state. */
export function cachedPanel(value: unknown): AgentPanelState | null {
  if (!record(value) || !Array.isArray(value.messages) || !record(value.turns)) return null
  const messages: AgentPanelMessage[] = []
  for (const raw of value.messages) {
    if (!record(raw) || typeof raw.id !== 'string' || typeof raw.turnId !== 'string') return null
    const identity = { id: raw.id, turnId: raw.turnId }
    if (raw.kind === 'text') {
      if (typeof raw.text !== 'string' || (raw.role !== 'user' && raw.role !== 'assistant'))
        return null
      const references = cachedReferences(raw.references)
      if (references === null) return null
      messages.push({
        ...identity,
        kind: 'text',
        role: raw.role,
        text: raw.text,
        streaming: false,
        ...(references.length ? { references } : {}),
      })
    } else if (raw.kind === 'clarification') {
      if (
        typeof raw.question !== 'string' ||
        !Array.isArray(raw.options) ||
        !raw.options.every((option): option is string => typeof option === 'string')
      )
        return null
      messages.push({
        ...identity,
        kind: 'clarification',
        question: raw.question,
        options: raw.options,
      })
    } else if (raw.kind === 'imageAction') {
      const step = cachedImageAction(raw, identity)
      if (!step) return null
      messages.push(step)
    } else if (raw.kind === 'tool') {
      if (typeof raw.title !== 'string' || typeof raw.toolCallId !== 'string') return null
      const status = raw.status
      if (
        status !== 'running' &&
        status !== 'succeeded' &&
        status !== 'failed' &&
        status !== 'submitted' &&
        status !== 'queued' &&
        status !== 'awaiting_confirmation'
      )
        return null
      messages.push({
        ...identity,
        kind: 'tool',
        toolCallId: raw.toolCallId,
        title: raw.title,
        status,
        ...(typeof raw.prompt === 'string' ? { prompt: raw.prompt } : {}),
        ...(typeof raw.message === 'string' && !raw.errorCode ? { message: raw.message } : {}),
      })
    } else return null
  }
  const turns: Record<string, AgentTurnFooter> = {}
  for (const [id, raw] of Object.entries(value.turns)) {
    if (!record(raw) || typeof raw.turnId !== 'string') return null
    const cost = raw.cost
    const stopReason = raw.stopReason
    Object.defineProperty(turns, id, {
      enumerable: true,
      value: {
        turnId: raw.turnId,
        ...(finite(raw.durationMs) ? { durationMs: raw.durationMs } : {}),
        ...(stopReason === 'completed' || stopReason === 'failed' || stopReason === 'aborted'
          ? { stopReason }
          : {}),
        ...(record(cost) && finite(cost.chat) && finite(cost.image) && finite(cost.video)
          ? {
              cost: {
                chat: cost.chat,
                image: cost.image,
                video: cost.video,
                ...(finite(cost.chatWaived) || cost.chatWaived === null
                  ? { chatWaived: cost.chatWaived }
                  : {}),
              },
            }
          : {}),
      },
    })
  }
  return { messages, turns }
}

function cachedImageAction(
  raw: Record<string, unknown>,
  identity: { id: string; turnId: string },
): AgentImageActionStep | null {
  if (
    raw.action !== 'removeBackground' ||
    (raw.status !== 'running' && raw.status !== 'succeeded' && raw.status !== 'failed') ||
    typeof raw.sourceMessageId !== 'string' ||
    typeof raw.artifactId !== 'string'
  )
    return null
  return {
    ...identity,
    kind: 'imageAction',
    action: 'removeBackground',
    status: raw.status,
    sourceMessageId: raw.sourceMessageId,
    artifactId: raw.artifactId,
    ...(typeof raw.thumbnail === 'string' ? { thumbnail: raw.thumbnail } : {}),
    ...(typeof raw.resultSource === 'string' ? { resultSource: raw.resultSource } : {}),
    ...(finite(raw.durationMs) ? { durationMs: raw.durationMs } : {}),
    ...(finite(raw.credits) ? { credits: raw.credits } : {}),
    ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
  }
}

function cachedReferences(value: unknown): NonNullable<AgentTextMessage['references']> | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const references: NonNullable<AgentTextMessage['references']>[number][] = []
  for (const raw of value) {
    if (!record(raw) || typeof raw.imageId !== 'string') return null
    const identity = {
      imageId: raw.imageId,
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    }
    if (typeof raw.dataUrl === 'string') references.push({ ...identity, dataUrl: raw.dataUrl })
    else if (typeof raw.mediaId === 'string') references.push({ ...identity, mediaId: raw.mediaId })
    else if (
      record(raw.image) &&
      typeof raw.image.object === 'string' &&
      typeof raw.image.mime === 'string'
    )
      references.push({
        ...identity,
        image: {
          object: raw.image.object,
          mime: raw.image.mime,
          ...(raw.image.store === 'durable' ? { store: 'durable' as const } : {}),
        },
      })
    else return null
  }
  return references
}
