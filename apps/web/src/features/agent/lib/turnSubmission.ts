import {
  AGENT_TURN_MAX_INLINE_REFERENCES,
  type AgentCanvasSnapshot,
  type AgentMode,
  type AgentTurnParams,
  type AgentTurnReference,
} from '@image-playground/shared'
import { mediaIdentity } from '../../../lib/cloudMedia'
import {
  localAttachmentIdentity,
  localAttachmentMatchesSource,
} from '../../../lib/localAttachmentSources'
import { peekCanvasWorkspace } from '../../canvas/lib/activeProject'
import { liveCanvasSnapshot } from '../../canvas/lib/canvasSnapshot'
import { type CanvasProject, projectExperience } from '../../canvas/lib/projectRepository'
import { canvasSceneKey } from '../../canvas/lib/workspaceKeys'
import { inlineReferenceCount } from './agentClient'
import { canReuseAttachmentMedia, prepareAttachmentReferences } from './attachmentUploads'

export interface TurnSubmissionSnapshot {
  readonly references: readonly AgentTurnReference[]
  readonly canvas?: AgentCanvasSnapshot
  /** 兼容旧的本机发送记录；新记录始终保存参数。 */
  readonly params?: AgentTurnParams
  /** 发话时已确认引用像素等于画布原图的元素；遮罩和批注不在此列。 */
  readonly canvasReferenceIds?: readonly string[]
  /**
   * 发话时看到的入口。服务端在项目记下入口之前按它判定：画布还在加载时带不了快照，
   * 只看快照会把画布里说的话当成对话。
   */
  readonly experience?: 'chat' | 'canvas'
}

export type TurnSubmissionReplay = Omit<TurnSubmissionSnapshot, 'references'> & {
  readonly clarificationAnswer?: boolean
}

/** 服务端尚未受理的一次发话，可交还草稿并原样再发。 */
export interface UnsentTurnSubmission extends TurnSubmissionSnapshot {
  readonly id: string
  readonly text: string
  readonly mode: AgentMode
  readonly clarificationAnswer: boolean
}

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
    (!input.project || projectExperience(input.project) === 'canvas') &&
    workspace &&
    !state?.loading &&
    !state?.loadFailed &&
    !(
      input.conversationId &&
      input.project?.conversationId &&
      input.project.conversationId !== input.conversationId
    )
  const chat = input.project && projectExperience(input.project) === 'chat'
  let canvas: AgentCanvasSnapshot | undefined
  let canvasReferenceIds: readonly string[] | undefined = []
  if (!chat && input.replay) {
    canvas = input.replay.canvas
    canvasReferenceIds = input.replay.canvasReferenceIds
  } else if (!chat && readable) {
    canvas = liveCanvasSnapshot(workspace.doc, (fileId, source) =>
      cloud?.knownMediaId(fileId, source),
    )
    canvasReferenceIds = input.references.flatMap((reference) => {
      if (!('dataUrl' in reference) || reference.maskDataUrl) return []
      const element = workspace.doc.elements.find((one) => one.id === reference.imageId)
      return element?.type === 'image' && workspace.doc.files[element.fileId] === reference.dataUrl
        ? [element.id]
        : []
    })
  }
  const localCandidates =
    !chat && !input.replay && readable
      ? input.references.flatMap((reference) => {
          if (
            !('dataUrl' in reference) ||
            reference.maskDataUrl ||
            !localAttachmentIdentity(reference.dataUrl)
          )
            return []
          const element = workspace.doc.elements.find((one) => one.id === reference.imageId)
          const source = element?.type === 'image' ? workspace.doc.files[element.fileId] : undefined
          return source ? [{ imageId: reference.imageId, handle: reference.dataUrl, source }] : []
        })
      : []
  const experience =
    input.replay?.experience ?? (input.project ? projectExperience(input.project) : undefined)
  let snapshot: TurnSubmissionSnapshot = structuredClone({
    references: input.references,
    params: input.replay?.params ?? input.params,
    ...(experience ? { experience } : {}),
    ...(canvas ? { canvas } : {}),
    ...(canvasReferenceIds ? { canvasReferenceIds } : {}),
  })

  return {
    get snapshot() {
      return snapshot
    },
    resolveCanvasBindings: localCandidates.length
      ? async () => {
          const matched = [...(snapshot.canvasReferenceIds ?? [])]
          while (localCandidates.length) {
            const candidate = localCandidates.shift()!
            if (await localAttachmentMatchesSource(candidate.handle, candidate.source))
              matched.push(candidate.imageId)
          }
          snapshot = { ...snapshot, canvasReferenceIds: matched }
        }
      : undefined,
    async prepare(): Promise<TurnSubmissionSnapshot | null> {
      const local = snapshot.references.flatMap((reference) =>
        'dataUrl' in reference &&
        !reference.maskDataUrl &&
        reference.dataUrl.startsWith('data:image/')
          ? [reference.dataUrl]
          : [],
      )
      const ids = cloud && local.length ? await cloud.mediaIdsFor(local) : new Map<string, string>()
      const references = await prepareAttachmentReferences(
        snapshot.references.map((reference) => {
          if (!('dataUrl' in reference) || !canReuseAttachmentMedia(reference)) return reference
          const mediaId = ids.get(reference.dataUrl) ?? mediaIdentity(reference.dataUrl)
          if (!mediaId) return reference
          const { dataUrl: _source, maskDataUrl: _mask, ...rest } = reference
          return { ...rest, mediaId }
        }),
      )
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
                  return element.type === 'image' && mediaId ? { ...element, mediaId } : element
                }),
              },
            }
          : {}),
      }
    },
  }
}
