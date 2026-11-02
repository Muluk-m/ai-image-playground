import { resolveStageVideoExecution, type StageExecutionSpec } from '@image-playground/shared'
import type { VideoModelOption } from '../../../lib/channels/videoChannels'
import type { VideoDraft } from '../../video/types'
import type { NodeReference } from './nodeCanvasFlow'
import type { NodeVideoMode } from './nodeVideoModes'

export function nodeVideoConfiguration(
  meta: Record<string, string>,
  references: readonly NodeReference[],
  globalDraft: VideoDraft,
  options: readonly VideoModelOption[],
) {
  const resolved = resolveStageVideoExecution({
    meta,
    references,
    globalDraft,
    options: options.map((option) => ({ modelId: option.modelId, support: option.support })),
  })
  const option =
    options.find((one) => one.modelId === resolved.draft.model) ??
    (options.length ? options[0] : undefined)
  return {
    option,
    mode: resolved.mode as NodeVideoMode,
    support: option ? resolved.support : undefined,
    draft: resolved.draft as VideoDraft,
    spec: resolved.spec satisfies StageExecutionSpec,
    legacyFirst: resolved.legacyFirst,
    legacyLast: resolved.legacyLast,
  }
}
