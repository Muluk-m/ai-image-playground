import { agentImageCount } from './agent'
import type { CanvasNode } from './canvas-document'
import { canvasNodeKind } from './canvas-registry'
import {
  canonicalVideoVoice,
  clampVideoPreset,
  effectiveVideoNodeMode,
  narrowVideoModelSupport,
  VIDEO_ASPECT_RATIOS,
  VIDEO_RESOLUTIONS,
  type VideoAspectRatio,
  type VideoModelSupport,
  type VideoNodeMode,
  type VideoResolution,
  videoRateMultiplier,
} from './video-presets'

/**
 * 一个节点真正提交时的模型、数量和倍率。
 * 提案、确认、预检、扣费和任务定价都用这一份，不能各自再解析一遍草稿。
 */
export interface StageExecutionSpec {
  readonly model: string
  readonly quantity: number
  readonly unitMultiplier: number
}

export interface StageNodeExecutionSpec extends StageExecutionSpec {
  readonly nodeId: string
}

/** 视频时长向上取整。已经是整数的档位保持不变；无效数量原样返回，交给调用方拒绝。 */
export function billedStageQuantity(quantity: number): number {
  if (!Number.isFinite(quantity)) return quantity
  const ceiled = Math.ceil(quantity)
  return Number.isSafeInteger(ceiled) && ceiled >= 1 ? ceiled : quantity
}

/**
 * 确认时拿现场规格和提案快照比。数量先做同一次向上取整。
 * 快照模型为空时，现场模型可以补上（不计费占位）；已经写了模型再变，就是另一份规格。
 */
export function stageExecutionSpecsMatch(
  live: readonly StageNodeExecutionSpec[],
  snapshot: readonly StageNodeExecutionSpec[],
): boolean {
  if (live.length !== snapshot.length) return false
  const liveIds = new Set(live.map((item) => item.nodeId))
  if (liveIds.size !== live.length) return false
  const seen = new Set<string>()
  for (const item of snapshot) {
    if (seen.has(item.nodeId)) return false
    seen.add(item.nodeId)
  }
  if (seen.size !== liveIds.size) return false
  return live.every((item) => {
    const stored = snapshot.find((one) => one.nodeId === item.nodeId)
    if (!stored) return false
    const modelMatches = stored.model === item.model || stored.model === ''
    return (
      modelMatches &&
      billedStageQuantity(stored.quantity) === billedStageQuantity(item.quantity) &&
      stored.unitMultiplier === item.unitMultiplier
    )
  })
}

export interface StageVideoDraftFields {
  readonly model: string
  readonly duration: number
  readonly resolution: string
  readonly aspectRatio: string
  readonly voices?: readonly string[] | undefined
}

export interface StageVideoExecutionOption {
  readonly modelId: string
  readonly support: VideoModelSupport
}

/**
 * 四项都在才认节点上保存的草稿。缺任何一项整份作废，调用方改用工作台草稿。
 * 与画布 `nodeVideoConfiguration` 的判断相同。
 */
export function parseCompleteStageVideoDraft(
  raw: string | undefined,
): StageVideoDraftFields | undefined {
  try {
    const parsed = JSON.parse(raw ?? '')
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.model !== 'string' ||
      typeof parsed.duration !== 'number' ||
      typeof parsed.resolution !== 'string' ||
      typeof parsed.aspectRatio !== 'string'
    )
      return undefined
    return {
      model: parsed.model,
      duration: parsed.duration,
      resolution: parsed.resolution,
      aspectRatio: parsed.aspectRatio,
      voices: Array.isArray(parsed.voices)
        ? parsed.voices.filter((one: unknown): one is string => typeof one === 'string')
        : undefined,
    }
  } catch {
    return undefined
  }
}

function asVideoResolution(value: string | undefined): VideoResolution | undefined {
  return value !== undefined && (VIDEO_RESOLUTIONS as readonly string[]).includes(value)
    ? (value as VideoResolution)
    : undefined
}

function asVideoAspectRatio(value: string | undefined): VideoAspectRatio | undefined {
  return value !== undefined && (VIDEO_ASPECT_RATIOS as readonly string[]).includes(value)
    ? (value as VideoAspectRatio)
    : undefined
}

export interface StageVideoExecution {
  readonly legacyFirst?: string
  readonly legacyLast?: string
  readonly mode: VideoNodeMode
  readonly support?: VideoModelSupport
  readonly draft: StageVideoDraftFields
  readonly spec: StageExecutionSpec
}

/**
 * 画布节点实际会提交的视频规格。
 * 完整草稿盖过工作台草稿；不完整则整份用工作台草稿。
 * 模式、首尾帧、参考图和声音先收窄清晰度，再退到模型支持矩阵。没有矩阵时时长向上取整。
 */
export function resolveStageVideoExecution(input: {
  readonly meta: Readonly<Record<string, string | undefined>>
  readonly references: readonly { readonly id: string }[]
  readonly globalDraft: StageVideoDraftFields
  readonly options: readonly StageVideoExecutionOption[]
}): StageVideoExecution {
  const saved = parseCompleteStageVideoDraft(input.meta.nodeVideoDraft)
  const requestedModel = saved?.model ?? input.globalDraft.model
  const option = input.options.find((one) => one.modelId === requestedModel) ?? input.options[0]
  const legacyFirst = input.references.find((ref) => input.meta[`role:${ref.id}`] === 'first')?.id
  const legacyLast = input.references.find((ref) => input.meta[`role:${ref.id}`] === 'last')?.id
  let requestedMode = input.meta.nodeVideoMode
  if (requestedMode === undefined) {
    if (legacyLast) requestedMode = 'frames'
    else if (legacyFirst) requestedMode = 'first'
  }
  const mode: VideoNodeMode = option
    ? effectiveVideoNodeMode(option.support, requestedMode)
    : 'text'
  const requested: StageVideoDraftFields = {
    ...input.globalDraft,
    ...(saved ?? {}),
    model: option?.modelId ?? input.globalDraft.model,
  }
  const support = option
    ? narrowVideoModelSupport(option.support, mode, Boolean(requested.voices?.length))
    : undefined
  const billedDuration = billedStageQuantity(requested.duration)
  const aligned = { ...requested, duration: billedDuration }
  const draft = support ? clampStageVideoDraft(aligned, support) : aligned
  const quantity = draft.duration
  const resolution = asVideoResolution(draft.resolution)
  return {
    ...(legacyFirst ? { legacyFirst } : {}),
    ...(legacyLast ? { legacyLast } : {}),
    mode,
    ...(support ? { support } : {}),
    draft: { ...draft, duration: quantity },
    spec: {
      model: draft.model,
      quantity,
      unitMultiplier: resolution ? videoRateMultiplier(draft.model, resolution) : 1,
    },
  }
}

/**
 * 阶段授权里视频时长的唯一口径：先向上取整，再退到该模型在这一清晰度下的合法档。
 * 提案快照和带授权的提交都走这里，1.9 秒才会和冻结档位是同一个数。
 */
export function stageAuthorizedVideoDuration(
  duration: number,
  support: VideoModelSupport | undefined,
  resolution?: string,
): number {
  const billed = billedStageQuantity(duration)
  if (!support) return billed
  return clampVideoPreset(support, {
    duration: billed,
    resolution: asVideoResolution(resolution),
  }).duration
}

function clampStageVideoDraft(
  draft: StageVideoDraftFields,
  support: VideoModelSupport,
): StageVideoDraftFields {
  const voices = support.voices
    ? (draft.voices ?? [])
        .map((voice) => canonicalVideoVoice(voice))
        .filter((voice): voice is NonNullable<typeof voice> => voice !== null)
        .filter((voice, index, all) => all.indexOf(voice) === index)
        .slice(0, support.voices.max)
    : []
  const preset = clampVideoPreset(support, {
    duration: draft.duration,
    resolution: asVideoResolution(draft.resolution),
    aspectRatio: asVideoAspectRatio(draft.aspectRatio),
  })
  return {
    model: draft.model,
    duration: preset.duration,
    resolution: preset.resolution,
    aspectRatio: preset.aspectRatio,
    ...(voices.length ? { voices } : { voices: undefined }),
  }
}

/** 图片节点与画布批次共用：工作台模型、分镜单张、张数截断到 1..上限。 */
export function resolveStageImageExecution(input: {
  readonly model?: string | undefined
  readonly count?: number | undefined
  readonly storyboardRole?: string | undefined
}): StageExecutionSpec | undefined {
  const model = input.model?.trim() ?? ''
  if (!model) return undefined
  const single = input.storyboardRole === 'frame' || input.storyboardRole === 'grid'
  return {
    model,
    quantity: single ? 1 : agentImageCount({ n: input.count }),
    unitMultiplier: 1,
  }
}

/** 画布上直接连进目标节点的上游。提示词和输入张数都按这一跳，不沿祖先展开。 */
export interface StageBindingReference {
  readonly id: string
  readonly kind: 'image' | 'text' | 'video'
  readonly label: string
  readonly text?: string
  readonly fileId?: string
  readonly asset?: boolean
}

/**
 * 提案时冻结、提交时核对的执行内容。
 * 提示词、输入张数和视频档位来自服务端读到的画布，不接受客户端自报的指纹。
 */
export interface StageExecutionBinding {
  readonly nodeId: string
  readonly kind: 'image' | 'video'
  readonly prompt: string
  readonly inputCount: number
  readonly video?: {
    readonly durationSeconds: number
    readonly resolution: string
    readonly aspectRatio: string
  }
}

/** 队列里实际提交的内容。与绑定不一致就不能消耗阶段预算。 */
export interface StageExecutionFingerprint {
  readonly prompt: string
  readonly inputCount: number
  readonly video?: {
    readonly durationSeconds: number
    readonly resolution: string
    readonly aspectRatio: string
  }
}

export function stageIncomingReferences(
  nodes: readonly CanvasNode[],
  edges: readonly { readonly source: string; readonly target: string }[],
  targetId: string,
): StageBindingReference[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const refs: StageBindingReference[] = []
  for (const edge of edges) {
    if (edge.target !== targetId) continue
    const node = byId.get(edge.source)
    if (!node || node.type === 'timeline' || node.type === 'storyboard') continue
    if (node.type === 'text') {
      const text = node.data.text.trim()
      refs.push({ id: node.id, kind: 'text', label: text.slice(0, 42), text })
      continue
    }
    refs.push({
      id: node.id,
      kind: node.type === 'video' || node.data.meta?.nodeKind === 'video' ? 'video' : 'image',
      label: node.data.name?.trim() ?? '',
      ...(node.data.meta?.nodeKind === 'asset'
        ? {
            asset: true,
            text: [node.data.name, node.data.meta.assetDescription].filter(Boolean).join('：'),
          }
        : {}),
      ...(node.data.fileId ? { fileId: node.data.fileId } : {}),
    })
  }
  return refs
}

/** 连线顺序与画布 `referenceOrder` 一致；没点名的上游排在后面。 */
export function orderStageReferences<T extends { readonly id: string }>(
  refs: readonly T[],
  referenceOrder: string | undefined,
): T[] {
  let order: string[] = []
  try {
    const list = JSON.parse(referenceOrder ?? '[]')
    if (Array.isArray(list)) order = list.filter((id): id is string => typeof id === 'string')
  } catch {
    order = []
  }
  return [...refs].sort(
    (a, b) =>
      (order.includes(a.id) ? order.indexOf(a.id) : 999) -
      (order.includes(b.id) ? order.indexOf(b.id) : 999),
  )
}

export function stageAssetContext(node: CanvasNode): string {
  return node.type === 'image' && node.data.meta?.nodeKind === 'asset'
    ? [node.data.name, node.data.meta.assetDescription].filter(Boolean).join('：')
    : ''
}

/** 上游文字按连线顺序放在节点提示词前面。图片不进这句话。 */
export function stageComposedPrompt(
  nodePrompt: string,
  references: readonly {
    readonly kind: string
    readonly text?: string
    readonly asset?: boolean
  }[],
): string {
  const notes = references.flatMap((ref) =>
    (ref.kind === 'text' || ref.asset) && ref.text ? [ref.text] : [],
  )
  return [...notes, nodePrompt.trim()].filter(Boolean).join('\n')
}

export function stageNodePrompt(input: {
  readonly kind: 'image' | 'video'
  readonly nodePrompt: string
  readonly assetContext: string
  readonly references: readonly {
    readonly kind: string
    readonly text?: string
    readonly asset?: boolean
  }[]
}): string {
  return [
    input.kind === 'image' ? input.assetContext : '',
    stageComposedPrompt(input.nodePrompt, input.references),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** 视频模式挑出真正会送进队列的参考图，规则与画布 `nodeVideoInputs` 相同。 */
export function selectStageVideoReferences(
  mode: VideoNodeMode,
  refs: readonly StageBindingReference[],
  slots: { first?: string; last?: string } = {},
) {
  const images = refs.filter((ref) => ref.kind === 'image' && !ref.asset)
  const first = slots.first !== undefined ? images.find((ref) => ref.id === slots.first) : images[0]
  const last =
    slots.last !== undefined
      ? images.find((ref) => ref.id === slots.last)
      : images.find((ref) => ref.id !== first?.id)
  const seenFiles = new Set<string>()
  const uniqueReferences = refs.filter((ref) => {
    if (ref.kind !== 'image' || (ref.asset && !ref.fileId)) return false
    const key = ref.fileId ?? ref.id
    if (seenFiles.has(key)) return false
    seenFiles.add(key)
    return true
  })
  let selected: StageBindingReference[]
  if (mode === 'reference') selected = [...uniqueReferences]
  else if (mode === 'text') selected = []
  else {
    const frames = [first]
    if (mode === 'frames') frames.push(last)
    selected = frames.filter((ref): ref is StageBindingReference => Boolean(ref))
  }
  return {
    refs: [
      ...refs
        .filter((ref) => ref.kind === 'text' || (ref.asset && !selected.includes(ref)))
        .map((ref) => (ref.asset ? { ...ref, kind: 'text' as const, fileId: undefined } : ref)),
      ...selected,
    ],
    roles: Object.fromEntries(
      selected.map((ref) => [ref.id, stageVideoReferenceRole(mode, ref.id, first?.id)]),
    ),
    first: mode === 'first' || mode === 'frames' ? first : undefined,
    last: mode === 'frames' ? last : undefined,
    missing:
      ((mode === 'first' || mode === 'frames') && !first) ||
      (mode === 'frames' && (!last || last.id === first?.id)),
  }
}

/**
 * 阶段里真正参与这一节点的上游。
 * 同一阶段里还没出图的上游在挑选时记成批次来源，挑完仍用画布上的原引用，和批次执行一致。
 */
export function stageActiveReferences(input: {
  readonly kind: 'image' | 'video'
  readonly incoming: readonly StageBindingReference[]
  readonly authorizedIds: ReadonlySet<string>
  readonly video?: {
    readonly mode: VideoNodeMode
    readonly legacyFirst?: string
    readonly legacyLast?: string
    readonly explicitFirst?: string
    readonly explicitLast?: string
  }
}): { refs: StageBindingReference[]; roles: Record<string, string>; missing: boolean } {
  if (input.kind !== 'video' || !input.video)
    return { refs: [...input.incoming], roles: {}, missing: false }
  const stamped = input.incoming.map((ref) =>
    input.authorizedIds.has(ref.id) ? { ...ref, fileId: `batch-source:${ref.id}` } : ref,
  )
  const selected = selectStageVideoReferences(input.video.mode, stamped, {
    first: input.video.explicitFirst ?? input.video.legacyFirst,
    last: input.video.explicitLast ?? input.video.legacyLast,
  })
  return {
    refs: selected.refs.map((ref) =>
      ref.kind === 'image' && input.authorizedIds.has(ref.id)
        ? (input.incoming.find((original) => original.id === ref.id) ?? ref)
        : ref,
    ),
    roles: selected.roles,
    missing: selected.missing,
  }
}

type StageInputRef = {
  readonly id: string
  readonly kind: string
  readonly fileId?: string
  readonly asset?: boolean
}

/**
 * 一张会送进队列的图的身份。提案快照和提交清单都用这一条，张数才能和 input_images 对齐。
 * 本阶段会重跑的上游按节点计：现在共用一个文件，跑完也是两张新图。
 * 视频首帧、尾帧按槽位计，两个节点即使现在是同一个文件也会各交一张。
 * 阶段外的参考图有 fileId 就按文件去重；还没落成文件的按节点计。
 */
function stageInputIdentity(
  ref: { readonly id: string; readonly fileId?: string },
  authorizedIds: ReadonlySet<string>,
  role?: string,
): string {
  if (role === 'first' || role === 'last') return `slot:${role}:${ref.id}`
  if (authorizedIds.has(ref.id)) return `node:${ref.id}`
  if (ref.fileId) return `file:${ref.fileId}`
  return `node:${ref.id}`
}

function stageVideoReferenceRole(
  mode: VideoNodeMode,
  refId: string,
  firstId: string | undefined,
): 'reference' | 'first' | 'last' {
  if (mode === 'reference') return 'reference'
  if (refId === firstId) return 'first'
  return 'last'
}

function stageInputImages(refs: readonly StageInputRef[], authorizedIds: ReadonlySet<string>) {
  return refs.filter(
    (ref) =>
      ref.kind === 'image' && (!ref.asset || Boolean(ref.fileId) || authorizedIds.has(ref.id)),
  )
}

export function stageSubmittedFileIds(
  refs: readonly StageInputRef[],
  authorizedIds: ReadonlySet<string>,
  _kind: 'image' | 'video',
  roles: Readonly<Record<string, string>> = {},
): string[] {
  const fileIds: string[] = []
  const seen = new Set<string>()
  for (const ref of stageInputImages(refs, authorizedIds)) {
    const key = stageInputIdentity(ref, authorizedIds, roles[ref.id])
    if (seen.has(key)) continue
    seen.add(key)
    if (ref.fileId) fileIds.push(ref.fileId)
  }
  return fileIds
}

export function stageSubmittedInputCount(
  refs: readonly StageInputRef[],
  authorizedIds: ReadonlySet<string>,
  _kind: 'image' | 'video',
  roles: Readonly<Record<string, string>> = {},
): number {
  const seen = new Set<string>()
  for (const ref of stageInputImages(refs, authorizedIds)) {
    seen.add(stageInputIdentity(ref, authorizedIds, roles[ref.id]))
  }
  return seen.size
}

export function stageExecutionBinding(input: {
  readonly node: CanvasNode
  readonly nodes: readonly CanvasNode[]
  readonly edges: readonly { readonly source: string; readonly target: string }[]
  readonly authorizedIds: ReadonlySet<string>
  readonly video?: {
    readonly mode: VideoNodeMode
    readonly draft: StageVideoDraftFields
    readonly legacyFirst?: string
    readonly legacyLast?: string
  }
}): StageExecutionBinding {
  const kind = canvasNodeKind(input.node) === 'video' ? 'video' : 'image'
  const meta =
    input.node.type === 'image' || input.node.type === 'video' ? (input.node.data.meta ?? {}) : {}
  const incoming = orderStageReferences(
    stageIncomingReferences(input.nodes, input.edges, input.node.id),
    meta.referenceOrder,
  )
  const active = stageActiveReferences({
    kind,
    incoming,
    authorizedIds: input.authorizedIds,
    ...(input.video
      ? {
          video: {
            mode: input.video.mode,
            legacyFirst: input.video.legacyFirst,
            legacyLast: input.video.legacyLast,
            explicitFirst: meta.videoFirstFrame,
            explicitLast: meta.videoLastFrame,
          },
        }
      : {}),
  })
  return {
    nodeId: input.node.id,
    kind,
    prompt: stageNodePrompt({
      kind,
      nodePrompt: meta.nodePrompt ?? '',
      assetContext: kind === 'image' ? stageAssetContext(input.node) : '',
      references: active.refs,
    }),
    inputCount: stageSubmittedInputCount(active.refs, input.authorizedIds, kind, active.roles),
    ...(kind === 'video' && input.video
      ? {
          video: {
            durationSeconds: input.video.draft.duration,
            resolution: input.video.draft.resolution,
            aspectRatio: input.video.draft.aspectRatio,
          },
        }
      : {}),
  }
}

export function stageExecutionBindingMatches(
  binding: StageExecutionBinding,
  execution: StageExecutionFingerprint,
): boolean {
  if (binding.prompt !== execution.prompt || binding.inputCount !== execution.inputCount)
    return false
  if (binding.kind === 'video') {
    const video = binding.video
    const given = execution.video
    return Boolean(
      video &&
        given &&
        video.durationSeconds === given.durationSeconds &&
        video.resolution === given.resolution &&
        video.aspectRatio === given.aspectRatio,
    )
  }
  return execution.video === undefined
}
