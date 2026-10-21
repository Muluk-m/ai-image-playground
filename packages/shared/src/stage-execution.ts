import { agentImageCount } from './agent'
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
  const seen = new Set<string>()
  for (const item of snapshot) {
    if (seen.has(item.nodeId)) return false
    seen.add(item.nodeId)
  }
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
  const requestedMode =
    input.meta.nodeVideoMode ?? (legacyLast ? 'frames' : legacyFirst ? 'first' : undefined)
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
  const draft = support ? clampStageVideoDraft(requested, support) : requested
  const quantity = support ? draft.duration : billedStageQuantity(draft.duration)
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
