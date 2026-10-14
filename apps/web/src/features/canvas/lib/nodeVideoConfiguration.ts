import type { VideoModelOption } from '../../../lib/channels/videoChannels'
import { clampDraftToSupport } from '../../video/lib/draft'
import type { VideoDraft } from '../../video/types'
import type { NodeReference } from './nodeCanvasFlow'
import { effectiveNodeVideoMode, nodeVideoSupport } from './nodeVideoModes'

export function nodeVideoConfiguration(
  meta: Record<string, string>,
  references: readonly NodeReference[],
  globalDraft: VideoDraft,
  options: readonly VideoModelOption[],
) {
  let saved: Partial<VideoDraft> = {}
  try {
    const parsed = JSON.parse(meta.nodeVideoDraft ?? '{}')
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.model === 'string' &&
      typeof parsed.duration === 'number' &&
      typeof parsed.resolution === 'string' &&
      typeof parsed.aspectRatio === 'string'
    )
      saved = {
        model: parsed.model,
        duration: parsed.duration,
        resolution: parsed.resolution,
        aspectRatio: parsed.aspectRatio,
        voices: Array.isArray(parsed.voices)
          ? parsed.voices.filter((one: unknown) => typeof one === 'string')
          : undefined,
      }
  } catch {
    /* Older nodes start from the workbench's current draft. */
  }
  const option =
    options.find((one) => one.modelId === (saved.model ?? globalDraft.model)) ?? options[0]
  const legacyFirst = references.find((ref) => meta[`role:${ref.id}`] === 'first')?.id
  const legacyLast = references.find((ref) => meta[`role:${ref.id}`] === 'last')?.id
  const mode = option
    ? effectiveNodeVideoMode(
        option.support,
        meta.nodeVideoMode ?? (legacyLast ? 'frames' : legacyFirst ? 'first' : undefined),
      )
    : 'text'
  const requestedDraft = { ...globalDraft, ...saved, model: option?.modelId ?? globalDraft.model }
  const support = option
    ? nodeVideoSupport(option.support, mode, Boolean(requestedDraft.voices?.length))
    : undefined
  const draft = support ? clampDraftToSupport(requestedDraft, support) : requestedDraft
  return { option, mode, support, draft, legacyFirst, legacyLast }
}
