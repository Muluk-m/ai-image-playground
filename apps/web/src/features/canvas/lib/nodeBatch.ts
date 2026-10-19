import {
  type CanvasNode,
  type CanvasNodeJob,
  type CanvasSnapshot,
  canvasFingerprint,
  canvasMainResult,
  canvasNodeJobs,
  canvasNodeKind,
  canvasResults,
  readCanvasDocument,
  videoRateMultiplier,
  videoRequestRejection,
} from '@image-playground/shared'
import type { StageAuthorizationSubmission } from '@image-playground/shared'
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
import {
  composeNodePrompt,
  incomingReferences,
  type NodeReference,
  referenceFileIds,
} from './nodeCanvasFlow'
import { submitNodeImage } from './nodeCanvasGenerate'
import { submitNodeVideo } from './nodeCanvasVideo'
import { nodeVideoConfiguration } from './nodeVideoConfiguration'
import { nodeVideoInputs } from './nodeVideoModes'
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
export class NodeBatchFailure extends Error {
  constructor(public readonly code: NodeBatchError) {
    super(code)
  }
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
  const refs = incomingReferences(snapshot.nodes, snapshot.edges, node.id)
  const meta = 'meta' in node.data ? (node.data.meta ?? {}) : {}
  let order: string[] = []
  try {
    const list = JSON.parse(meta.referenceOrder ?? '[]')
    if (Array.isArray(list)) order = list.filter((id) => typeof id === 'string')
  } catch {}
  return refs.sort(
    (a, b) =>
      (order.includes(a.id) ? order.indexOf(a.id) : 999) -
      (order.includes(b.id) ? order.indexOf(b.id) : 999),
  )
}
/** Select generators only; text, imported media, assets and timelines remain their inputs. */
export function buildNodeBatch(input: NodeBatchInput): NodeBatchPlan {
  const { snapshot, settings, params } = input
  const selected = new Set(input.ids)
  for (const group of snapshot.groups ?? [])
    if (selected.has(group.id)) for (const id of group.members) selected.add(id)
  const nodes = snapshot.nodes.filter((node) => {
    if (!selected.has(node.id) || !['image', 'video'].includes(canvasNodeKind(node))) return false
    if (node.type !== 'image' && node.type !== 'video') return false
    const meta = node.data.meta ?? {}
    return (
      Boolean(meta.nodePrompt?.trim()) ||
      (meta.nodeKind !== 'asset' && snapshot.edges.some((edge) => edge.target === node.id))
    )
  })
  const ids = new Set(nodes.map((node) => node.id))
  const jobs: NodeBatchJob[] = []
  let error: NodeBatchError | undefined
  for (const node of nodes) {
    if (node.type !== 'image' && node.type !== 'video') continue
    const meta = node.data.meta ?? {},
      uploads = nodeReferenceDraft(input.document, node.id)
    if (
      uploads.uploading ||
      canvasNodeJobs(input.document, node.id).some((job) => job.status === 'loading')
    )
      error ??= 'busy'
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
    if (kind === 'video') {
      const config = nodeVideoConfiguration(meta, refs, input.videoDraft, input.options)
      if (!config.option) error ??= 'model'
      draft = config.draft
      model = draft.model
      quantity = draft.duration
      unitMultiplier = videoRateMultiplier(model, draft.resolution)
      const inputs = nodeVideoInputs(
        config.mode,
        refs.map((ref) => (ids.has(ref.id) ? { ...ref, fileId: `batch-source:${ref.id}` } : ref)),
        {
          first: meta.videoFirstFrame ?? config.legacyFirst,
          last: meta.videoLastFrame ?? config.legacyLast,
        },
      )
      activeRefs = inputs.refs.map((ref) =>
        ref.kind === 'image' && ids.has(ref.id)
          ? refs.find((original) => original.id === ref.id)!
          : ref,
      )
      roles = inputs.roles
      if (inputs.missing) error ??= 'media'
      const max =
        config.mode === 'reference' ? config.option?.support.referenceImages?.max : undefined
      if (max !== undefined && activeRefs.filter((ref) => ref.kind === 'image').length > max)
        error ??= 'limit'
    }
    const prompt = [
      kind === 'image' ? assetNodeContext(node) : '',
      composeNodePrompt(meta.nodePrompt ?? '', activeRefs),
    ]
      .filter(Boolean)
      .join('\n\n')
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
        error ??= 'model'
    }
    if (!prompt.trim() && (kind === 'video' || imageRefs.length === 0)) error ??= 'prompt'
    const referenceCount =
      new Set(imageRefs.filter((ref) => ids.has(ref.id)).map((ref) => ref.id)).size +
      referenceFileIds(
        imageRefs.filter((ref) => !ids.has(ref.id)),
        { ...input.files, ...temporary },
      ).length
    if (referenceCount > API_MAX_IMAGES) error ??= 'limit'
    if (
      imageRefs.some(
        (ref) =>
          !ids.has(ref.id) && (!ref.fileId || !(input.files[ref.fileId] || temporary[ref.fileId])),
      )
    )
      error ??= 'media'
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

/** Captured jobs are immutable; changed inputs/prices require a fresh confirmation. */
export async function executeNodeBatch(
  plan: NodeBatchPlan,
  control: {
    signal: AbortSignal
    current: () => NodeBatchPlan
    submit: (job: NodeBatchJob) => Promise<void>
    progress: (completed: number, id: string) => void
  },
) {
  if (plan.error) throw new NodeBatchFailure(plan.error)
  if (plan.blocked) throw new NodeBatchFailure('failed')
  for (const [index, job] of plan.jobs.entries()) {
    if (control.signal.aborted) throw new NodeBatchFailure('cancelled')
    const current = control.current()
    if (current.signature !== plan.signature) throw new NodeBatchFailure('changed')
    if (
      (index === 0 && current.blocked) ||
      (current.error && !(index > 0 && current.error === 'balance'))
    )
      throw new NodeBatchFailure(current.error ?? 'failed')
    control.progress(index, job.id)
    await control.submit(job)
  }
  control.progress(plan.jobs.length, '')
}

export async function runNodeBatch(
  doc: Y.Doc,
  editor: CanvasEditor,
  ids: readonly string[],
  plan: NodeBatchPlan,
  signal: AbortSignal,
  progress: (completed: number, id: string) => void,
  stageAuthorizations?: Readonly<Record<string, StageAuthorizationSubmission>>,
) {
  const sameAccount = accountScope()
  const completedResults = new Map<string, string>()
  const assertResults = () => {
    for (const [id, result] of completedResults) {
      if (canvasMainResult(doc, id)?.id !== result) throw new NodeBatchFailure('changed')
    }
  }
  await executeNodeBatch(plan, {
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
      const files = { ...editor.doc.files, ...current.temporary }
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
              referenceFileIds(current.refs, files).map((id) => files[id]!),
              undefined,
              undefined,
              { settings: plan.settings, params: { ...plan.params, n: job.quantity }, stageAuthorization: stageAuthorizations?.[job.id] },
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
    const finish = (error?: NodeBatchError) => {
      doc.off('update', check)
      doc.off('destroy', destroy)
      signal.removeEventListener('abort', cancel)
      error ? reject(new NodeBatchFailure(error)) : resolve()
    }
    const cancel = () => finish('cancelled'),
      destroy = () => finish('cancelled')
    const check = () => {
      if (signal.aborted || doc.isDestroyed) return finish('cancelled')
      if (!doc.getMap('nodes').has(id)) return finish('changed')
      const jobs = canvasNodeJobs(doc, id)
      remember(jobs)
      if (jobs.some((job) => job.status === 'error' || job.status === 'stale'))
        return finish('failed')
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
