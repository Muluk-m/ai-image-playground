import {
  AGENT_TURN_MAX_INLINE_REFERENCES,
  type AgentCanvasSnapshot,
  type AgentTurnParams,
  type AgentTurnReference,
} from '@image-playground/shared'
import { mediaIdentity } from '../../../lib/cloudMedia'
import { peekCanvasWorkspace } from '../../canvas/lib/activeProject'
import { liveCanvasSnapshot } from '../../canvas/lib/canvasSnapshot'
import type { CanvasProject } from '../../canvas/lib/projectRepository'
import { canvasSceneKey } from '../../canvas/lib/workspaceKeys'
import { inlineReferenceCount } from './agentClient'

export interface TurnSubmissionSnapshot {
  readonly references: readonly AgentTurnReference[]
  readonly canvas?: AgentCanvasSnapshot
  /** 兼容旧的本机发送记录；新记录始终保存参数。 */
  readonly params?: AgentTurnParams
  /** 发话时已确认引用像素等于画布原图的元素；遮罩和批注不在此列。 */
  readonly canvasReferenceIds?: readonly string[]
}

export type TurnSubmissionReplay = Omit<TurnSubmissionSnapshot, 'references'>

/** 同步固定本轮输入；异步准备只补媒体身份，不重读画布或当前设置。 */
export function captureTurnSubmission(input: {
  references: readonly AgentTurnReference[]
  params: AgentTurnParams
  conversationId: string | null
  project: CanvasProject | undefined
  replay?: TurnSubmissionReplay
}) {
  const current = peekCanvasWorkspace()
  const sceneKey = input.project?.sceneKey ?? canvasSceneKey(input.conversationId)
  const workspace = current?.record.key === sceneKey ? current : undefined
  const cloud = workspace?.cloud
  const state = workspace?.record.getSnapshot()
  const readable =
    workspace &&
    !state?.loading &&
    !state?.loadFailed &&
    !(
      input.conversationId &&
      input.project?.conversationId &&
      input.project.conversationId !== input.conversationId
    )
  const canvas = input.replay
    ? input.replay.canvas
    : readable
      ? liveCanvasSnapshot(workspace.doc, (fileId, source) => cloud?.knownMediaId(fileId, source))
      : undefined
  const canvasReferenceIds = input.replay
    ? input.replay.canvasReferenceIds
    : input.references.flatMap((reference) => {
        if (!readable || !('dataUrl' in reference) || reference.maskDataUrl) return []
        const element = workspace.doc.elements.find((one) => one.id === reference.imageId)
        return element?.type === 'image' &&
          workspace.doc.files[element.fileId] === reference.dataUrl
          ? [element.id]
          : []
      })
  const snapshot: TurnSubmissionSnapshot = structuredClone({
    references: input.references,
    params: input.replay?.params ?? input.params,
    ...(canvas ? { canvas } : {}),
    ...(canvasReferenceIds ? { canvasReferenceIds } : {}),
  })

  return {
    snapshot,
    async prepare(): Promise<TurnSubmissionSnapshot | null> {
      const local = snapshot.references.flatMap((reference) =>
        'dataUrl' in reference &&
        !reference.maskDataUrl &&
        reference.dataUrl.startsWith('data:image/')
          ? [reference.dataUrl]
          : [],
      )
      const ids = cloud && local.length ? await cloud.mediaIdsFor(local) : new Map<string, string>()
      const references = snapshot.references.map((reference) => {
        if (!('dataUrl' in reference) || reference.maskDataUrl) return reference
        const mediaId = ids.get(reference.dataUrl) ?? mediaIdentity(reference.dataUrl)
        if (!mediaId) return reference
        const { dataUrl: _source, maskDataUrl: _mask, ...rest } = reference
        return { ...rest, mediaId }
      })
      if (inlineReferenceCount(references) > AGENT_TURN_MAX_INLINE_REFERENCES) return null
      const matched = new Set(snapshot.canvasReferenceIds)
      const media = new Map(
        references.flatMap((reference) =>
          'mediaId' in reference && matched.has(reference.imageId)
            ? [[reference.imageId, reference.mediaId] as const]
            : [],
        ),
      )
      return {
        ...snapshot,
        references,
        ...(snapshot.canvas
          ? {
              canvas: {
                ...snapshot.canvas,
                elements: snapshot.canvas.elements.map((element) => {
                  const mediaId = media.get(element.id)
                  return element.type === 'image' && !element.mediaId && mediaId
                    ? { ...element, mediaId }
                    : element
                }),
              },
            }
          : {}),
      }
    },
  }
}
