import {
  type CanvasNode,
  type CanvasNodeJob,
  type CanvasSnapshot,
  canvasFingerprint,
  canvasMainResult,
  canvasNodeJobs,
  canvasNodeKind,
  canvasResults,
  orderStageReferences,
  readCanvasDocument,
  resolveStageImageExecution,
  STAGE_RUN_MAX_RETRIES,
  type StageAuthorizationSubmission,
  type StageRunReason,
  stageActiveReferences,
  stageIncomingReferences,
  stageNodePrompt,
  stageNodeRunnable,
  stageSubmittedFileIds,
  videoRequestRejection,
} from '@image-playground/shared'
import type * as Y from 'yjs'
import { clientProfileToApiProfile, getActiveApiProfile } from '../../../lib/apiProfiles'
import { accountScope } from '../../../lib/authScope'
import { type VideoModelOption, videoModelOptions } from '../../../lib/channels/videoChannels'
import { API_MAX_IMAGES } from '../../../lib/inputImageLimit'
import { getPrivateSubmissionGuard, type PrivateSubmissionGuard } from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import type { AppSettings, TaskParams } from '../../../types'
import { useVideoStore } from '../../video/store'
import type { VideoDraft } from '../../video/types'
import type { CanvasEditor } from './editor'
import { assetNodeContext } from './nodeAssetGeneration'
import { type NodeReference, referenceFileIds } from './nodeCanvasFlow'
import { submitNodeImage } from './nodeCanvasGenerate'
import { submitNodeVideo } from './nodeCanvasVideo'
import { takeNodeJobFailure } from './nodeJobFailures'
import { nodeVideoConfiguration } from './nodeVideoConfiguration'
import { nodeReferenceDraft } from './useNodeReferenceDraft'

export type NodeBatchError =
  | 'empty'
  | 'cycle'
  | 'busy'
  | 'prompt'
  | 'media'
  | 'model'
  | 'changed'
  | 'failed'
  | 'cancelled'
  | 'limit'
  | 'balance'
  | 'authorization'
  | 'stale'
  | 'local'
export class NodeBatchFailure extends Error {
  constructor(
    public readonly code: NodeBatchError,
    /** `failed` 时 BFF 拒绝提交给的错误码（如 `stage_authorization_scope`），没有就是上游失败。 */
    public readonly submitError?: string,
  ) {
    super(code)
  }
}
/** 视频时长与阶段报价对齐：支持矩阵里的档位已经是整数，没有矩阵时向上取整。 */
export function billedNodeQuantity(job: Pick<NodeBatchJob, 'kind' | 'quantity'>): number {
  if (job.kind !== 'video') return job.quantity
  const quantity = Math.ceil(job.quantity)
  return Number.isSafeInteger(quantity) && quantity >= 1 ? quantity : job.quantity
}
export interface NodeBatchJob {
  id: string
  kind: 'image' | 'video'
  label: string
  model: string
  quantity: number
  unitMultiplier?: number
  prompt: string
  refs: NodeReference[]
  roles: Record<string, string>
  temporary: Record<string, string>
  draft?: VideoDraft
  dependencies: string[]
  /** 这个节点自己开跑前就被拦下的原因；智能体运行回报按它说明缺什么。 */
  blocked?: StageRunReason
}
export interface NodeBatchPlan {
  jobs: NodeBatchJob[]
  signature: string
  credits?: number
  blocked?: boolean
  blockedReason?: string
  error?: NodeBatchError
  settings: AppSettings
  params: TaskParams
}
export interface NodeBatchInput {
  snapshot: CanvasSnapshot
  ids: readonly string[]
  document: Y.Doc
  files: Readonly<Record<string, string>>
  settings: AppSettings
  params: TaskParams
  videoDraft: VideoDraft
  options: readonly VideoModelOption[]
  guard?: typeof getPrivateSubmissionGuard
}
function referencesFor(snapshot: CanvasSnapshot, node: CanvasNode) {
  const meta = 'meta' in node.data ? (node.data.meta ?? {}) : {}
  return orderStageReferences(
    stageIncomingReferences(snapshot.nodes, snapshot.edges, node.id),
    meta.referenceOrder,
  )
}
/** Select generators only; text, imported media, assets and timelines remain their inputs. */
export function buildNodeBatch(input: NodeBatchInput): NodeBatchPlan {
  const { snapshot, settings, params } = input
  const selected = new Set(input.ids)
  for (const group of snapshot.groups ?? [])
    if (selected.has(group.id)) for (const id of group.members) selected.add(id)
  // 与服务端阶段授权同一条规则：没写提示词的素材有描述就按描述出图。
  const nodes = snapshot.nodes.filter(
    (node) => selected.has(node.id) && stageNodeRunnable(node, snapshot.edges),
  )
  const ids = new Set(nodes.map((node) => node.id))
  const jobs: NodeBatchJob[] = []
  let error: NodeBatchError | undefined
  for (const node of nodes) {
    if (node.type !== 'image' && node.type !== 'video') continue
    const meta = node.data.meta ?? {},
      uploads = nodeReferenceDraft(input.document, node.id)
    let blocked: StageRunReason | undefined
    const block = (code: NodeBatchError, reason: StageRunReason) => {
      error ??= code
      blocked ??= reason
    }
    if (
      uploads.uploading ||
      canvasNodeJobs(input.document, node.id).some((job) => job.status === 'loading')
    )
      block('busy', 'busy')
    const temporary = Object.fromEntries(uploads.items.map((item) => [item.id, item.url]))
    const refs: NodeReference[] = [
      ...referencesFor(snapshot, node),
      ...uploads.items.map((item) => ({
        id: item.id,
        fileId: item.id,
        label: item.name,
        kind: 'image' as const,
      })),
    ]
    const kind = canvasNodeKind(node) === 'video' ? 'video' : 'image'
    const imageProfile = clientProfileToApiProfile(getActiveApiProfile(settings))
    let activeRefs = refs,
      roles: Record<string, string> = {},
      draft: VideoDraft | undefined,
      model = imageProfile.model,
      quantity = ['frame', 'grid'].includes(meta.storyboardRole ?? '') ? 1 : params.n,
      unitMultiplier: number | undefined
    const image = resolveStageImageExecution({
      model: imageProfile.model,
      count: params.n,
      storyboardRole: meta.storyboardRole,
    })
    if (kind === 'image' && image) {
      model = image.model
      quantity = image.quantity
    }
    if (kind === 'video') {
      const config = nodeVideoConfiguration(meta, refs, input.videoDraft, input.options)
      if (!config.option) block('model', 'model_unavailable')
      draft = config.draft
      model = config.spec.model
      quantity = config.spec.quantity
      unitMultiplier = config.spec.unitMultiplier
      const inputs = stageActiveReferences({
        kind,
        incoming: refs,
        authorizedIds: ids,
        video: {
          mode: config.mode,
          legacyFirst: config.legacyFirst,
          legacyLast: config.legacyLast,
          explicitFirst: meta.videoFirstFrame,
          explicitLast: meta.videoLastFrame,
        },
      })
      activeRefs = inputs.refs
      roles = inputs.roles
      if (inputs.missing) block('media', 'missing_frame')
      const max =
        config.mode === 'reference' ? config.option?.support.referenceImages?.max : undefined
      if (max !== undefined && activeRefs.filter((ref) => ref.kind === 'image').length > max)
        block('limit', 'input_limit')
    }
    const prompt = stageNodePrompt({
      kind,
      nodePrompt: meta.nodePrompt ?? '',
      assetContext: assetNodeContext(node),
      references: activeRefs,
    })
    const imageRefs = activeRefs.filter(
      (ref) => ref.kind === 'image' && (!ref.asset || ref.fileId || ids.has(ref.id)),
    )
    if (draft) {
      const images = activeRefs.filter((ref) => ref.kind === 'image')
      const first = images.findIndex((ref) => roles[ref.id] === 'first')
      const last = images.findIndex((ref) => roles[ref.id] === 'last')
      const referenceIndices = images.flatMap((ref, i) =>
        roles[ref.id] === 'reference' ? [i] : [],
      )
      if (
        videoRequestRejection(
          model,
          {
            duration_seconds: draft.duration,
            aspect_ratio: draft.aspectRatio,
            resolution: draft.resolution,
            ...(first >= 0 ? { first_frame_index: first } : {}),
            ...(last >= 0 ? { last_frame_index: last } : {}),
            ...(referenceIndices.length ? { reference_image_indices: referenceIndices } : {}),
            ...(draft.voices?.length ? { voices: draft.voices } : {}),
          },
          images.length,
        )
      )
        block('model', 'model_unavailable')
    }
    if (!prompt.trim() && (kind === 'video' || imageRefs.length === 0))
      block('prompt', 'missing_prompt')
    const referenceCount =
      new Set(imageRefs.filter((ref) => ids.has(ref.id)).map((ref) => ref.id)).size +
      referenceFileIds(
        imageRefs.filter((ref) => !ids.has(ref.id)),
        { ...input.files, ...temporary },
      ).length
    if (referenceCount > API_MAX_IMAGES) block('limit', 'input_limit')
    if (
      imageRefs.some(
        (ref) =>
          !ids.has(ref.id) && (!ref.fileId || !(input.files[ref.fileId] || temporary[ref.fileId])),
      )
    )
      block('media', 'missing_media')
    jobs.push({
      id: node.id,
      kind,
      label: node.data.name || meta.nodePrompt?.slice(0, 60) || '',
      model,
      quantity,
      ...(unitMultiplier === undefined ? {} : { unitMultiplier }),
      prompt,
      refs: activeRefs,
      roles,
      temporary,
      ...(draft ? { draft } : {}),
      dependencies: activeRefs.filter((ref) => ids.has(ref.id)).map((ref) => ref.id),
      ...(blocked ? { blocked } : {}),
    })
  }
  const sorted: NodeBatchJob[] = [],
    remaining = [...jobs]
  while (remaining.length) {
    const index = remaining.findIndex((job) =>
      job.dependencies.every((id) => sorted.some((done) => done.id === id)),
    )
    if (index < 0) {
      error ??= 'cycle'
      break
    }
    sorted.push(remaining.splice(index, 1)[0]!)
  }
  // Each request rounds independently in the BFF; adding quantities before quoting undercounts.
  const guards: PrivateSubmissionGuard[] = jobs.map((job) =>
    (input.guard ?? getPrivateSubmissionGuard)({
      model: job.model,
      quantity: job.quantity,
      unitMultiplier: job.unitMultiplier,
    }),
  )
  const credits =
    guards.length && guards.every((guard) => guard.estimatedCredits !== undefined)
      ? guards.reduce((total, guard) => total + guard.estimatedCredits!, 0)
      : undefined
  if (
    credits !== undefined &&
    guards.some((guard) => guard.availableCredits === undefined || guard.availableCredits < credits)
  )
    error ??= 'balance'
  const signature = canvasFingerprint(
    JSON.stringify({
      settings,
      params,
      jobs: jobs.map(({ label: _label, ...job }) => ({
        ...job,
        refs: job.refs.map((ref) => (ids.has(ref.id) ? { id: ref.id, kind: ref.kind } : ref)),
      })),
      external: snapshot.nodes
        .filter(
          (node) =>
            !ids.has(node.id) && jobs.some((job) => job.refs.some((ref) => ref.id === node.id)),
        )
        .map((node) => ({ id: node.id, data: node.data })),
      credits,
    }),
  )
  return {
    blocked: guards.some((guard) => guard.blocked),
    jobs: error === 'cycle' ? jobs : sorted,
    signature,
    credits,
    blockedReason: guards.find((guard) => guard.blocked)?.disabledReason,
    error: error ?? (jobs.length ? undefined : 'empty'),
    settings: structuredClone(settings),
    params: { ...params },
  }
}

export function currentNodeBatch(doc: Y.Doc, editor: CanvasEditor, ids: readonly string[]) {
  const { settings, params } = useStore.getState()
  return buildNodeBatch({
    snapshot: readCanvasDocument(doc),
    ids,
    document: doc,
    files: editor.doc.files,
    settings,
    params,
    videoDraft: useVideoStore.getState().draft,
    options: videoModelOptions(),
  })
}

/**
 * 单个节点失败之后怎么办。缺席时整批停下（手动执行一组的老规矩）；智能体的阶段运行用它在授权内
 * 重试一次，或者记下失败、跳过依赖它的下游，接着跑其余节点。
 */
export interface NodeBatchHooks {
  /**
   * 返回 `retry` 再提交一次（同一节点至多 `STAGE_RUN_MAX_RETRIES` 次，超出按 `skip` 处理）；
   * 返回 `skip` 记为失败并跳过下游；抛出则整批停下。
   */
  recover?: (job: NodeBatchJob, error: unknown) => Promise<'retry' | 'skip'>
  /** 节点有了真实结果。 */
  completed?: (job: NodeBatchJob) => void
  /** 节点依赖的上游没有结果，没有提交。 */
  skipped?: (job: NodeBatchJob) => void
}

/** Captured jobs are immutable; changed inputs/prices require a fresh confirmation. */
export async function executeNodeBatch(
  plan: NodeBatchPlan,
  control: {
    signal: AbortSignal
    current: () => NodeBatchPlan
    submit: (job: NodeBatchJob) => Promise<void>
    progress: (completed: number, id: string) => void
  } & NodeBatchHooks,
) {
  if (plan.error) throw new NodeBatchFailure(plan.error)
  if (plan.blocked) throw new NodeBatchFailure('failed')
  const dropped = new Set<string>()
  for (const [index, job] of plan.jobs.entries()) {
    if (control.signal.aborted) throw new NodeBatchFailure('cancelled')
    if (job.dependencies.some((id) => dropped.has(id))) {
      dropped.add(job.id)
      control.skipped?.(job)
      continue
    }
    const current = control.current()
    if (current.signature !== plan.signature) throw new NodeBatchFailure('changed')
    if (
      (index === 0 && current.blocked) ||
      (current.error && !(index > 0 && current.error === 'balance'))
    )
      throw new NodeBatchFailure(current.error ?? 'failed')
    control.progress(index, job.id)
    // 执行器自己也把住重试次数：钩子一直要 `retry` 也只再提交这么多次，之后按放弃处理。
    for (let retries = 0; ; retries += 1) {
      try {
        await control.submit(job)
        control.completed?.(job)
        break
      } catch (error) {
        if (!control.recover) throw error
        const next = await control.recover(job, error)
        if (next === 'retry' && retries < STAGE_RUN_MAX_RETRIES) {
          if (control.signal.aborted) throw new NodeBatchFailure('cancelled')
          continue
        }
        dropped.add(job.id)
        break
      }
    }
  }
  control.progress(plan.jobs.length, '')
}

/**
 * 阶段提交的图片清单与服务端冻结张数使用同一套身份。
 * 本阶段会重跑的上游各交一张；阶段外的图按 fileId 去重。
 * 只在浏览器里的临时上传不在这份清单里：服务端快照看不到它们，确认前就会拒绝。
 */
export function stageAuthorizedImageInputs(
  refs: readonly NodeReference[],
  files: Readonly<Record<string, string>>,
  authorizedIds: ReadonlySet<string>,
  temporary: Readonly<Record<string, string>>,
): string[] {
  const onCanvas = refs.filter(
    (ref) => !temporary[ref.id] && !(ref.fileId && temporary[ref.fileId]),
  )
  return stageSubmittedFileIds(onCanvas, authorizedIds, 'image').map((id) => {
    const url = files[id]
    if (!url) throw new NodeBatchFailure('media')
    return url
  })
}

export async function runNodeBatch(
  doc: Y.Doc,
  editor: CanvasEditor,
  ids: readonly string[],
  plan: NodeBatchPlan,
  signal: AbortSignal,
  progress: (completed: number, id: string) => void,
  stageAuthorizations?: Readonly<Record<string, StageAuthorizationSubmission>>,
  hooks: NodeBatchHooks = {},
) {
  const sameAccount = accountScope()
  const completedResults = new Map<string, string>()
  const assertResults = () => {
    for (const [id, result] of completedResults) {
      if (canvasMainResult(doc, id)?.id !== result) throw new NodeBatchFailure('changed')
    }
  }
  await executeNodeBatch(plan, {
    ...hooks,
    signal,
    progress,
    current: () => {
      if (!sameAccount() || doc.isDestroyed) throw new NodeBatchFailure('cancelled')
      assertResults()
      return currentNodeBatch(doc, editor, ids)
    },
    submit: async (job) => {
      const current = currentNodeBatch(doc, editor, ids).jobs.find((one) => one.id === job.id)
      if (!current) throw new NodeBatchFailure('changed')
      const stage = stageAuthorizations?.[job.id]
      const files = { ...editor.doc.files, ...current.temporary }
      const authorizedIds = new Set(plan.jobs.map((item) => item.id))
      if (
        current.refs.some(
          (ref) =>
            ref.kind === 'image' &&
            (!ref.asset || ref.fileId) &&
            (!ref.fileId || !files[ref.fileId]),
        )
      )
        throw new NodeBatchFailure('media')
      const previous = new Set(canvasResults(doc, job.id).map((result) => result.id))
      const previousJobs = new Set(canvasNodeJobs(doc, job.id).map((one) => one.id))
      const accepted =
        job.kind === 'image'
          ? submitNodeImage(
              editor,
              doc,
              job.id,
              job.prompt,
              stage
                ? stageAuthorizedImageInputs(current.refs, files, authorizedIds, current.temporary)
                : referenceFileIds(current.refs, files).map((id) => files[id]!),
              undefined,
              undefined,
              {
                settings: plan.settings,
                params: { ...plan.params, n: job.quantity },
                stageAuthorization: stageAuthorizations?.[job.id],
              },
            )
          : submitNodeVideo(
              editor,
              doc,
              job.id,
              job.prompt,
              current.refs,
              current.roles,
              files,
              job.draft,
              stageAuthorizations?.[job.id],
            )
      if (!accepted) throw new NodeBatchFailure('failed')
      await waitForNodeBatchResult(
        doc,
        job.id,
        previous,
        previousJobs,
        canvasNodeJobs(doc, job.id).filter((one) => !previousJobs.has(one.id)),
        signal,
      )
      assertResults()
      completedResults.set(job.id, canvasMainResult(doc, job.id)!.id)
    },
  })
}

function waitForNodeBatchResult(
  doc: Y.Doc,
  id: string,
  previous: ReadonlySet<string>,
  previousJobs: ReadonlySet<string>,
  submitted: readonly CanvasNodeJob[],
  signal: AbortSignal,
): Promise<void> {
  const submittedIds = new Set(submitted.map((job) => job.id))
  const taskIds = new Set<string>()
  const remember = (jobs: readonly CanvasNodeJob[]) => {
    for (const job of jobs)
      if (submittedIds.has(job.id)) {
        taskIds.add(`canvas:${job.meta.clientRequestId}`)
        if (job.meta.bffRequestId) taskIds.add(job.meta.bffRequestId)
      }
  }
  remember(submitted)
  return new Promise((resolve, reject) => {
    const finish = (error?: NodeBatchError, submitError?: string) => {
      doc.off('update', check)
      doc.off('destroy', destroy)
      signal.removeEventListener('abort', cancel)
      error ? reject(new NodeBatchFailure(error, submitError)) : resolve()
    }
    const cancel = () => finish('cancelled'),
      destroy = () => finish('cancelled')
    const check = () => {
      if (signal.aborted || doc.isDestroyed) return finish('cancelled')
      if (!doc.getMap('nodes').has(id)) return finish('changed')
      // 只看这一次提交建出的任务：同一节点上一次失败留下的错误任务（授权内重试时）不算这次失败。
      const jobs = canvasNodeJobs(doc, id).filter((job) => !previousJobs.has(job.id))
      remember(jobs)
      const failedJob = jobs.find((job) => job.status === 'error' || job.status === 'stale')
      if (failedJob) return finish('failed', takeNodeJobFailure(failedJob.id))
      if (jobs.some((job) => job.status === 'loading')) return
      const main = canvasMainResult(doc, id)
      finish(
        main && !previous.has(main.id) && 'taskId' in main.source && taskIds.has(main.source.taskId)
          ? undefined
          : 'changed',
      )
    }
    doc.on('update', check)
    doc.on('destroy', destroy)
    signal.addEventListener('abort', cancel, { once: true })
    check()
  })
}
