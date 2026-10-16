import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { startGeneration } from '../../../lib/generationJob'
import { getPrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { removeKeyedBackgroundFromDataUrl } from '../../../lib/transparentImage'
import { useStore } from '../../../store'
import { CUTOUT_INSTRUCTION } from '../../canvas/lib/canvasImageEdits'
import { useAgentStore } from '../store'
import type { AgentImageActionStep } from '../types'

/**
 * 对话里的去背景走画布同一条路：让模型把背景换成纯色，再在本地把那块纯色键掉。
 * 结果不落画布，追加成对话里的一步。
 */
export async function runChatBackgroundRemoval(input: {
  sourceMessageId: string
  turnId: string
  artifactId: string
  thumbnail?: string
  loadSource: () => Promise<string | null>
}): Promise<void> {
  const store = useAgentStore.getState()
  const id = `cutout-${input.artifactId}-${crypto.randomUUID()}`
  const step: AgentImageActionStep = {
    kind: 'imageAction',
    id,
    turnId: input.turnId,
    sourceMessageId: input.sourceMessageId,
    artifactId: input.artifactId,
    action: 'removeBackground',
    status: 'running',
    ...(input.thumbnail ? { thumbnail: input.thumbnail } : {}),
  }
  store.appendImageAction(step)

  const source = await input.loadSource().catch(() => null)
  if (!source) {
    useAgentStore.getState().patchImageAction(id, {
      status: 'failed',
      error: 'source_unavailable',
    })
    return
  }

  const settings = useStore.getState().settings
  const profile = getActiveApiProfile(settings)
  const model = clientProfileToApiProfile(profile).model
  const params = {
    ...useStore.getState().params,
    n: 1,
    output_format: 'png' as const,
    output_compression: null,
  }
  const startedAt = Date.now()
  const handles = startGeneration(
    {
      settings,
      profile,
      params,
      variants: [
        {
          prompt: CUTOUT_INSTRUCTION,
          inputImageDataUrls: [source],
          context: { id },
        },
      ],
    },
    {
      open: () => ({ id, startedAt }),
      accepted: () => {},
      progress: () => {},
      delivered: async (_handle, result) => {
        const image = result.images[0]
        if (!image) {
          useAgentStore.getState().patchImageAction(id, { status: 'failed' })
          return
        }
        let keyed = image
        try {
          keyed = await removeKeyedBackgroundFromDataUrl(image)
        } catch {
          keyed = image
        }
        const credits = getPrivateSubmissionGuard({ model, quantity: 1 }).estimatedCredits
        useAgentStore.getState().patchImageAction(id, {
          status: 'succeeded',
          resultSource: keyed,
          durationMs: Date.now() - startedAt,
          ...(credits !== undefined ? { credits } : {}),
        })
      },
      failed: (_handle, failure) => {
        useAgentStore.getState().patchImageAction(id, {
          status: 'failed',
          error: failure.text,
          durationMs: Date.now() - startedAt,
        })
      },
    },
  )
  if (!handles.length) useAgentStore.getState().dismissImageAction(id)
}
