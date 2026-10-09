import type {
  VideoGenerationRecord,
  VideoModelSupport,
  VideoPreset,
  VideoPresetConflict,
  VideoRejection,
} from '@image-playground/shared'
import {
  AGENT_CONFIRMATION_PROMPT_MAX_CHARS,
  agentTitleLine,
  canonicalVideoVoice,
  clampVideoPreset,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_RESOLUTION_LABELS,
  VIDEO_RESOLUTIONS,
  videoDurationsForResolution,
  videoPresetConflicts,
  videoRequestRejection,
} from '@image-playground/shared'
import { Type } from 'typebox'
import { isCapabilityEnabled } from '../../capabilities'
import { requireAgentImages } from '../images'
import { agentVideoModel, agentVideoModels, agentVideoRequestError } from '../video-models'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'
import { reviewParameter } from './queueParams'
import { draftQueueTask, noModelMessage } from './queueTask'

const TITLE_MAX_CHARS = 32

/**
 * 给这段视频记下真正定下的档位与模型：随草稿冻结，确认提交时记到任务上，任务结束后由结算
 * 照它记到产物上。画布据此「改一个参数重来」和续写。记的是补齐后的档位，不是模型请求的原值。
 */
function videoRecord(
  model: string,
  preset: VideoPreset,
  firstFrameId: string | null,
  referenceIds: readonly string[] = [],
  lastFrameId?: string,
  keyframes: readonly { imageId: string; timestampSeconds: number }[] = [],
  voices: readonly string[] = [],
): VideoGenerationRecord {
  return {
    model,
    duration: preset.duration,
    aspectRatio: preset.aspectRatio,
    resolution: preset.resolution,
    ...(firstFrameId ? { firstFrameId } : {}),
    ...(lastFrameId ? { lastFrameId } : {}),
    ...(referenceIds.length ? { referenceIds: [...referenceIds] } : {}),
    ...(keyframes.length
      ? {
          keyframes: keyframes.map((frame) => ({
            imageId: frame.imageId,
            timestampSeconds: frame.timestampSeconds,
          })),
        }
      : {}),
    ...(voices.length ? { voices: [...voices] } : {}),
  }
}

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((id): id is string => typeof id === 'string' && id !== '')
}

/** 参考图 id：去重，并去掉与首尾帧相同的那张——一张图在一段视频里只有一种用法。 */
function referenceIdsOf(
  imageId: unknown,
  referenceImageIds: unknown,
  lastFrameId?: unknown,
): string[] {
  return [...new Set(stringIds(referenceImageIds))].filter(
    (id) => id !== imageId && id !== lastFrameId,
  )
}

interface PlannedKeyframe {
  readonly imageId: string
  readonly timestampSeconds: number
}

/** 模型填的关键帧。残缺项丢掉，剩下的交给共享校验说清楚为什么不行。 */
function keyframePlans(value: unknown): PlannedKeyframe[] {
  if (!Array.isArray(value)) return []
  const plans: PlannedKeyframe[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const imageId = (item as { imageId?: unknown }).imageId
    const timestampSeconds = (item as { timestampSeconds?: unknown }).timestampSeconds
    if (typeof imageId !== 'string' || imageId === '') continue
    if (typeof timestampSeconds !== 'number') continue
    plans.push({ imageId, timestampSeconds })
  }
  return plans
}

/** 认得出的声音收成规范 id；认不出的原样留下，好让校验报「不认识」。 */
function voicePlans(value: unknown): string[] {
  return stringIds(value).map((id) => canonicalVideoVoice(id) ?? id)
}

/** 同一张图出现在两种角色里。参考图与首尾帧的别名重叠已在 referenceIdsOf 里去掉。 */
function imageRoleClash(ids: readonly (string | null | undefined)[]): boolean {
  const seen = new Set<string>()
  for (const id of ids) {
    if (!id) continue
    if (seen.has(id)) return true
    seen.add(id)
  }
  return false
}

/** 参数说明与系统提示里的参考图一句话，按矩阵写这个模型带不带得了、最多几张、清晰度封顶。 */
function referenceText(support: VideoModelSupport): string {
  const references = support.referenceImages
  if (!references) return `${support.label} 不支持参考图，别填。`
  return `${support.label} 最多 ${references.max} 张，带参考图时清晰度最高 ${VIDEO_RESOLUTION_LABELS[references.maxResolution]}，${references.withFrames ? '可以同时给 imageId 作起始帧' : '不能同时给 imageId'}。`
}

/**
 * 带参考图时的档位与驳回。用户没说清晰度就压到参考图的上限；说了且超限、张数超限、模型带不了、
 * 不能与起始帧同用——都由共享矩阵给出驳回 code，不提交。
 */
function referencePlan(
  modelId: string,
  support: VideoModelSupport,
  preset: VideoPreset,
  askedResolution: VideoPreset['resolution'] | undefined,
  referenceCount: number,
  hasFirstFrame: boolean,
  hasLastFrame = false,
  guides: { keyframes?: readonly PlannedKeyframe[]; voices?: readonly string[] } = {},
): { preset: VideoPreset; rejection: VideoRejection | null } {
  // 共享校验读全局矩阵，看不到渠道开关；渠道没声明就在这里先按「带不了」驳回。
  if (referenceCount > 0 && !support.referenceImages)
    return {
      preset,
      rejection: {
        code: 'referenceUnsupported',
        params: { label: support.label },
        reason: `${support.label} 不支持参考图`,
      },
    }
  const voices = (guides.voices ?? []).filter((id) => id !== '')
  const keyframes = guides.keyframes ?? []
  if (voices.length > 0 && !support.voices)
    return {
      preset,
      rejection: {
        code: 'voicesUnsupported',
        params: { label: support.label },
        reason: `${support.label} 不支持预设声音`,
      },
    }
  if (keyframes.length > 0 && !support.keyframes)
    return {
      preset,
      rejection: {
        code: 'keyframesUnsupported',
        params: { label: support.label },
        reason: `${support.label} 不支持关键帧`,
      },
    }
  const cap = referenceCount > 0 ? support.referenceImages?.maxResolution : undefined
  const lowered =
    cap &&
    !askedResolution &&
    VIDEO_RESOLUTIONS.indexOf(preset.resolution) > VIDEO_RESOLUTIONS.indexOf(cap)
      ? clampVideoPreset(support, { ...preset, resolution: cap })
      : preset
  // 压清晰度只能动清晰度：若因此换掉了别的档位（分清晰度定时长的模型），宁可不压，交给驳回说清楚。
  const capped =
    lowered.duration === preset.duration && lowered.aspectRatio === preset.aspectRatio
      ? lowered
      : preset
  const first = hasFirstFrame ? 1 : 0
  const frames = first + (hasLastFrame ? 1 : 0)
  const keyframeStart = frames + referenceCount
  const rejection = videoRequestRejection(
    modelId,
    {
      duration_seconds: capped.duration,
      aspect_ratio: capped.aspectRatio,
      resolution: capped.resolution,
      ...(hasFirstFrame ? { first_frame_index: 0 } : {}),
      ...(hasLastFrame ? { last_frame_index: first } : {}),
      ...(referenceCount
        ? {
            reference_image_indices: Array.from(
              { length: referenceCount },
              (_, index) => index + frames,
            ),
          }
        : {}),
      ...(keyframes.length
        ? {
            keyframes: keyframes.map((frame, index) => ({
              image_index: keyframeStart + index,
              timestamp_seconds: frame.timestampSeconds,
            })),
          }
        : {}),
      ...(voices.length ? { voices: [...voices] } : {}),
    },
    referenceCount + frames + keyframes.length,
  )
  return { preset: capped, rejection }
}

function roleRefusal(): {
  content: [{ type: 'text'; text: string }]
  details: Record<string, never>
} {
  return {
    content: [
      {
        type: 'text',
        text: [
          '没有提交这次生视频：同一张图只能担任一种角色。',
          '首帧、尾帧、参考图和关键帧各用不同的图，定了再重试。不要假装已经出片。',
          'unsupported_video_references {"code":"keyframeImageMissing"}',
        ].join('\n'),
      },
    ],
    details: {},
  }
}

function referenceRefusalText(
  modelId: string,
  support: VideoModelSupport,
  found: VideoRejection,
): string {
  return [
    `没有提交这次生视频：${found.reason}。${referenceText(support)}`,
    '把这个限制如实告诉用户：可以少用几张参考图、降低清晰度，或者换成起始帧；定了再重试。不要假装已经出片。',
    `unsupported_video_references ${JSON.stringify({ model: modelId, code: found.code })}`,
  ].join('\n')
}

/**
 * 能跑的视频模型：既要在这个部署的 channel 里，也要在支持矩阵里。
 * 少判一半，工具就会进模型的清单，然后在执行时抛——那一轮直接死掉。
 */
const videoModel = (model?: string) => agentVideoModel(model) ?? null

/** 这个模型的时长档。分清晰度的模型逐档写清：不分档写，模型会以为 1080p 也能要 4 秒。 */
function durationText(support: VideoModelSupport): string {
  if (!support.durationsByResolution) return `${support.durations.join(' / ')} 秒`
  return support.resolutions
    .map(
      (resolution) =>
        `${VIDEO_RESOLUTION_LABELS[resolution]} 下 ${videoDurationsForResolution(
          support,
          resolution,
        ).join(' / ')} 秒`,
    )
    .join('，')
}

function resolutionText(support: VideoModelSupport): string {
  return support.resolutions.map((one) => VIDEO_RESOLUTION_LABELS[one]).join(' / ')
}

/** 「这个部署做得到什么」的一句话；参数说明、系统提示词与驳回回执共用它。 */
function supportText(support: VideoModelSupport): string {
  return `时长 ${durationText(support)}，清晰度 ${resolutionText(support)}，画幅 ${support.aspectRatios.join(' / ')}`
}

/** 模型填了这个部署做不到的值时该怎么办。三个档位参数说明里各带一份。 */
const ASK_ANYWAY =
  '用户没说就别填；他说了这里没有的值，照他的原话填——工具不会替他换一档，会把做得到的告诉你。'

/**
 * 按这个部署此刻解析到的视频模型写参数说明。**取值集合一律保持全量**：收窄了模型就只能
 * 替用户挑一个别的档位，而那正是要治的病——用户明说的约束被静默换掉。留着填得出来，
 * 执行时才有机会如实说「这个模型做不到 X，它能做 A / B / C」。
 */
function videoParameters(support: VideoModelSupport | null) {
  const named = support ? `${support.label} 支持` : '这个部署的模型支持'
  const durations = support ? durationText(support) : `${VIDEO_DURATIONS.join(' / ')} 秒`
  const resolutions = support
    ? resolutionText(support)
    : VIDEO_RESOLUTIONS.map((one) => VIDEO_RESOLUTION_LABELS[one]).join(' / ')
  const ratios = (support?.aspectRatios ?? VIDEO_ASPECT_RATIOS).join(' / ')
  return Type.Object({
    model: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        description: `视频模型 ID；不填使用部署默认，指定后不会静默换模型。可用模型：${
          agentVideoModels()
            .map(
              ({ target, support }) =>
                `${target.model}（${support.label}：${supportText(support)}；首帧${support.firstFrame ? '可用' : '不可用'}，尾帧${support.lastFrame ? '可用' : '不可用'}；${referenceText(support)}${support.voices ? `预设声音最多 ${support.voices.max} 个。` : ''}${support.keyframes ? `关键帧最多 ${support.keyframes.max} 个。` : ''}）`,
            )
            .join('；') || '暂无'
        }。`,
      }),
    ),
    prompt: Type.String({
      minLength: 1,
      maxLength: AGENT_CONFIRMATION_PROMPT_MAX_CHARS,
      description: '描述这段视频里发生什么：主体、动作、镜头怎么动。用用户说话的语言写。',
    }),
    imageId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        description:
          '要动起来的那张图的图片 id，视频从它开始，产出也放在它旁边。不填就是纯文生视频。',
      }),
    ),
    lastFrameId: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 128,
        description:
          '结束帧的图片 ID；只有支持尾帧的模型才能使用。与 imageId 组合指定从首帧到尾帧的过渡。不要把普通参考图当成尾帧。',
      }),
    ),
    referenceImageIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
        maxItems: 16,
        description: `参考图的图片 id（全能参考）：人物、道具、场景各一张，按提示词里「图片1、图片2」的顺序排。${support ? referenceText(support) : ''}用户没给参考图就别填；只想让一张图动起来用 imageId。`,
      }),
    ),
    voiceIds: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 32 }), {
        maxItems: 3,
        description:
          '预设声音 id，按提示词里 <AUDIO_0> 的顺序，最多 3 个。常用 ara、eve、leo、rex、sal，其它预设 id 也可。不支持的模型别填。',
      }),
    ),
    keyframes: Type.Optional(
      Type.Array(
        Type.Object({
          imageId: Type.String({ minLength: 1, maxLength: 128 }),
          timestampSeconds: Type.Number({ exclusiveMinimum: 0 }),
        }),
        {
          maxItems: 4,
          description:
            '片中关键帧，最多 4 个。每项是图片 id 和秒。时间必须在成片内部并对齐到 1/3 秒，不能当作首尾帧。一张图只担任一种角色。',
        },
      ),
    ),
    durationSeconds: Type.Optional(
      Type.Number({ description: `视频时长（秒）。${named} ${durations}。${ASK_ANYWAY}` }),
    ),
    resolution: Type.Optional(
      Type.Union(
        VIDEO_RESOLUTIONS.map((value) => Type.Literal(value)),
        { description: `清晰度。${named} ${resolutions}。${ASK_ANYWAY}` },
      ),
    ),
    aspectRatio: Type.Optional(
      Type.Union(
        VIDEO_ASPECT_RATIOS.map((value) => Type.Literal(value)),
        { description: `画幅。${named} ${ratios}。${ASK_ANYWAY}说了竖屏就填 9:16。` },
      ),
    ),
    reviewAfterCompletion: reviewParameter,
  })
}

const GUIDANCE_BASE =
  '用户要让画面动起来时调生视频工具；视频慢也贵，他没明说要视频就别自作主张。这一次到底提交了没有以工具回执那句话为准，不要自己假定。'

function videoGuidance(): string {
  const support = videoModel()?.support
  if (!support) return GUIDANCE_BASE
  return `${GUIDANCE_BASE}默认视频模型是 ${support.label}：${supportText(support)}。参考图：${referenceText(support)}工具 model 参数列出可用模型及能力；用户指定模型就原样填 ID，不指定时可根据首尾帧和参考图需求选择支持的模型。尾帧填 lastFrameId。用户引用了几张图、要它们一起出现在片子里时，把它们放进 referenceImageIds。预设声音按提示词里 <AUDIO_0> 的顺序填 voiceIds，片中时刻填 keyframes（落在成片内部，不能当首尾）。用户明说的档位它做不到时，工具不会发起生成、也不会替他换一档，按回执说明限制。不要声称看过生成视频的运动或音频内容；图片查看工具只能看封面。`
}

const FIELD_PARAMS: Record<VideoPresetConflict['field'], string> = {
  duration: 'durationSeconds',
  resolution: 'resolution',
  aspectRatio: 'aspectRatio',
}

function conflictLine(support: VideoModelSupport, conflict: VideoPresetConflict): string {
  // 时长的可选项跟着清晰度走，所以整张时长表都写出来，模型换值时才不会又撞一次墙。
  const supported =
    conflict.field === 'duration' ? durationText(support) : conflict.supported.join(' / ')
  return `- ${FIELD_PARAMS[conflict.field]}：你填的是 ${conflict.asked}，${support.label} 支持 ${supported}`
}

/**
 * 明说的档位做不到时的回执。**不是失败**：`onError: 'abort'` 会把整轮停掉，模型就没机会
 * 把实话讲给用户。所以它是一个正常结果，内容是「做不到什么、能做什么、接下来怎么办」。
 * 末行那段 JSON 是给日志与后续自动化读的，前面几行是给模型读的，同一件事说两遍。
 */
function refusalText(
  modelId: string,
  support: VideoModelSupport,
  conflicts: readonly VideoPresetConflict[],
): string {
  return [
    `没有提交这次生视频：${support.label} 做不到你填的档位。视频是这里最贵的一件事，与其花钱交付一段用户没要的，不如先把话说清楚。`,
    ...conflicts.map((conflict) => conflictLine(support, conflict)),
    '用户明说过这个值：把上面的支持范围如实告诉他，让他选一个，定了再重试；用户没明说过：直接挑最接近的支持值重调一次，并在回复里说明你替他定了什么。不要假装已经出片。',
    `unsupported_video_preset ${JSON.stringify({ model: modelId, conflicts })}`,
  ].join('\n')
}

/** 拟稿定下的到底是哪一档。模型没填的项按矩阵退档，退到哪也要说出口，不能只有我们知道。 */
function draftedPresetText(support: VideoModelSupport, preset: VideoPreset): string {
  return `待确认的档位：${preset.duration} 秒 / ${VIDEO_RESOLUTION_LABELS[preset.resolution]} / ${preset.aspectRatio}（${support.label}，${supportText(support)}）。用户没指定的项由这个模型的矩阵补齐；回复时如实说你替他定了什么。`
}

/** 模型填的档位里，这个部署做不到的那几项。`call()` 与 `execute()` 同一个算式。 */
function conflictsFor(args: {
  readonly model?: string | undefined
  readonly durationSeconds?: number | undefined
  readonly resolution?: VideoPreset['resolution'] | undefined
  readonly aspectRatio?: VideoPreset['aspectRatio'] | undefined
}): VideoPresetConflict[] {
  const resolved = videoModel(args.model)
  if (!resolved) return []
  return videoPresetConflicts(resolved.support, {
    duration: args.durationSeconds,
    aspectRatio: args.aspectRatio,
    resolution: args.resolution,
  })
}

/** `call()` 用：这次的参考图会不会被驳回。与 `execute()` 同一个算式。 */
function referenceRejectionFor(args: {
  readonly model?: string | undefined
  readonly lastFrameId?: string | undefined
  readonly imageId: string | null
  readonly references: readonly string[]
  readonly keyframes?: readonly PlannedKeyframe[]
  readonly voices?: readonly string[]
  readonly durationSeconds?: number | undefined
  readonly resolution?: VideoPreset['resolution'] | undefined
  readonly aspectRatio?: VideoPreset['aspectRatio'] | undefined
}): boolean {
  const resolved = videoModel(args.model)
  if (!resolved) return true
  const asked = {
    duration: args.durationSeconds,
    aspectRatio: args.aspectRatio,
    resolution: args.resolution,
  }
  const plan = referencePlan(
    resolved.target.model,
    resolved.support,
    clampVideoPreset(resolved.support, asked),
    args.resolution,
    args.references.length,
    args.imageId !== null,
    Boolean(args.lastFrameId),
    { keyframes: args.keyframes, voices: args.voices },
  )
  return plan.rejection !== null
}

export const generateVideo = defineAgentTool({
  name: 'generateVideo',
  // 画布只在视频轮提供；Chat 由工具装配显式开放，仍要求用户明确提出视频需求。
  modes: ['video'],
  label: '生视频',
  // 拟稿即收尾：对话模式下档位与提示词交给用户确认，不提交任务、不落画布。出图模式当场提交。
  confirms: true,
  description:
    '发起一次生视频，完成后显示在对话的产物卡片中，带封面可播放。给了图片 id 就从那张图动起来，不给就按提示词凭空生成。视频比图片慢得多也贵得多，用户明确要视频时才调。提交前要不要先等用户确认由系统决定，见系统提示词里的生成流程那一段——工具返回的那句话会说清这一次到底提交了没有，照它说。',
  guidance: videoGuidance,
  // 静态的那份只在解析不出模型时用得上（那时工具本来就不在清单里），形状由它定型。
  parameters: videoParameters(null),
  currentParameters: () => videoParameters(videoModel()?.support ?? null),
  // 视频是这里最贵的一件事，失败让模型接着重试等于再扣一次费；停下来交给用户定夺。
  onError: 'abort',
  available: () => isCapabilityEnabled('generation:video') && videoModel() !== null,
  target: (_params, args) =>
    videoModel(typeof args.model === 'string' ? args.model : undefined)?.target,
  call({
    prompt,
    imageId,
    lastFrameId,
    model,
    referenceImageIds,
    voiceIds,
    keyframes: keyframeArgs,
    durationSeconds,
    resolution,
    aspectRatio,
  }) {
    const written = typeof prompt === 'string' ? prompt : undefined
    const references = referenceIdsOf(imageId, referenceImageIds, lastFrameId)
    const keyframes = keyframePlans(keyframeArgs)
    const voices = voicePlans(voiceIds)
    const first = typeof imageId === 'string' && imageId ? imageId : null
    const last = typeof lastFrameId === 'string' && lastFrameId ? lastFrameId : undefined
    // 档位、参考图、声音或关键帧做不到就不提交，也就不会有产物。画布跟着不占位——`outputCount`
    // 必须与真正提交的张数同一个算式，否则那里会空出一个永远填不上的框。
    const refused =
      conflictsFor({ model, durationSeconds, resolution, aspectRatio }).length > 0 ||
      imageRoleClash([first, last, ...references, ...keyframes.map((frame) => frame.imageId)]) ||
      referenceRejectionFor({
        imageId: first,
        model,
        lastFrameId: last,
        references,
        keyframes,
        voices,
        durationSeconds,
        resolution,
        aspectRatio,
      })
    const anchor = first ?? last ?? references[0] ?? keyframes[0]?.imageId
    return {
      title: written?.trim() ? `视频：${agentTitleLine(written, TITLE_MAX_CHARS)}` : '生视频',
      // 视频任务一次只出一段，图片参数里的 n 对它没有意义。
      ...(refused ? {} : { outputCount: 1 }),
      // 给了起始帧就贴着它放——与执行时的 `anchorObjectId` 取同一项。
      ...(anchor
        ? {
            anchor,
            references: [
              ...(first ? [first] : []),
              ...(last ? [last] : []),
              ...references,
              ...keyframes.map((frame) => frame.imageId),
            ],
          }
        : {}),
      ...(written ? { prompt: written } : {}),
    }
  },
  execute(context) {
    return async (toolCallId, params, signal) => {
      if (!isCapabilityEnabled('generation:video'))
        throw new AgentToolError('model_unavailable', noModelMessage('video'))
      const resolved = videoModel(params.model)
      if (!resolved) throw new AgentToolError('model_unavailable', noModelMessage('video'))
      const { support, target } = resolved
      const asked = {
        duration: params.durationSeconds,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
      }
      const conflicts = videoPresetConflicts(support, asked)
      // 用户明说的约束做不到时，宁可不花钱先说，也不要花了钱交付一个不对的东西。
      if (conflicts.length > 0)
        return {
          content: [{ type: 'text', text: refusalText(target.model, support, conflicts) }],
          details: {},
        }
      // Normalize before any capability/count/resolution check: aliases must not
      // turn an existing frame into an extra reference or lower its resolution.
      const firstFrameId = params.imageId ? context.images.identify(params.imageId) : undefined
      const lastFrameId = params.lastFrameId
        ? context.images.identify(params.lastFrameId)
        : undefined
      const referenceIds = referenceIdsOf(
        firstFrameId,
        params.referenceImageIds?.map((id) => context.images.identify(id)),
        lastFrameId,
      )
      const keyframes = keyframePlans(params.keyframes).map((frame) => ({
        ...frame,
        imageId: context.images.identify(frame.imageId),
      }))
      const voices = voicePlans(params.voiceIds)
      // 一张图两种角色是正常回执，不能抛：抛了 onError 会把整轮停掉。
      if (
        imageRoleClash([
          firstFrameId,
          lastFrameId,
          ...referenceIds,
          ...keyframes.map((frame) => frame.imageId),
        ])
      )
        return roleRefusal()
      const plan = referencePlan(
        target.model,
        support,
        clampVideoPreset(support, asked),
        params.resolution,
        referenceIds.length,
        Boolean(firstFrameId),
        Boolean(lastFrameId),
        { keyframes, voices },
      )
      if (plan.rejection)
        return {
          content: [
            { type: 'text', text: referenceRefusalText(target.model, support, plan.rejection) },
          ],
          details: {},
        }
      const preset = plan.preset
      const source = firstFrameId
        ? (await requireAgentImages(context.images, [firstFrameId]))[0]!
        : null
      const last = lastFrameId
        ? (await requireAgentImages(context.images, [lastFrameId]))[0]!
        : null
      // Resolve aliases before de-duplicating: "image 1" and its stable ID are the same input.
      const used = new Set([source?.imageId, last?.imageId].filter(Boolean))
      const references = (await requireAgentImages(context.images, referenceIds)).filter(
        (image) => {
          if (used.has(image.imageId)) return false
          used.add(image.imageId)
          return true
        },
      )
      const keyframeImages = keyframes.length
        ? await requireAgentImages(
            context.images,
            keyframes.map((frame) => frame.imageId),
          )
        : []
      const ordered = [
        ...(source ? [source] : []),
        ...(last ? [last] : []),
        ...references,
        ...keyframeImages,
      ]
      const inputImages = ordered.map((one) => one.dataUrl)
      const referenceStart = (source ? 1 : 0) + (last ? 1 : 0)
      const keyframeStart = referenceStart + references.length
      const recordedKeyframes = keyframeImages.map((image, index) => ({
        imageId: image.imageId,
        timestampSeconds: keyframes[index]!.timestampSeconds,
      }))
      const video = {
        duration_seconds: preset.duration,
        aspect_ratio: preset.aspectRatio,
        resolution: preset.resolution,
        ...(source ? { first_frame_index: 0 } : {}),
        ...(last ? { last_frame_index: source ? 1 : 0 } : {}),
        ...(references.length
          ? { reference_image_indices: references.map((_, index) => referenceStart + index) }
          : {}),
        ...(recordedKeyframes.length
          ? {
              keyframes: recordedKeyframes.map((frame, index) => ({
                image_index: keyframeStart + index,
                timestamp_seconds: frame.timestampSeconds,
              })),
            }
          : {}),
        ...(voices.length ? { voices: [...voices] } : {}),
      }
      const prompt = params.prompt.trim()
      const rejected = agentVideoRequestError(target.model, prompt, video, inputImages.length)
      if (rejected) throw new AgentToolError(rejected.code, rejected.message)
      // 产出贴着起始帧放；没有起始帧就贴着第一张参考图，再没有就贴着关键帧。
      const anchorImage = source ?? last ?? references[0] ?? keyframeImages[0]
      const outcome = await draftQueueTask(
        context,
        {
          toolName: 'generateVideo',
          media: 'video',
          toolCallId,
          target,
          prompt,
          referenceIds: ordered.map((one) => one.imageId),
          ...(inputImages.length ? { inputImages } : {}),
          video,
          // 档位随草稿冻结：确认提交时记到任务上，任务结束后再照它记到产物上。
          videoRecord: videoRecord(
            target.model,
            preset,
            source?.imageId ?? null,
            references.map((one) => one.imageId),
            last?.imageId,
            recordedKeyframes,
            voices,
          ),
          ...(anchorImage ? { anchorObjectId: anchorImage.imageId } : {}),
          review: params.reviewAfterCompletion === true,
        },
        signal,
      )
      // 结果块只读 `details`，所以多这一段文字不动前端协议：它只进模型的上下文。
      return {
        ...outcome,
        content: [...outcome.content, { type: 'text', text: draftedPresetText(support, preset) }],
      }
    }
  },
})
