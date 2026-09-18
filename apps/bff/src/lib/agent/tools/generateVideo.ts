import type {
  AgentToolArtifact,
  VideoGenerationRecord,
  VideoModelSupport,
  VideoPreset,
  VideoPresetConflict,
} from '@image-playground/shared'
import {
  agentTitleLine,
  clampVideoPreset,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_MODEL_SUPPORT,
  VIDEO_RESOLUTION_LABELS,
  VIDEO_RESOLUTIONS,
  videoDurationsForResolution,
  videoPresetConflicts,
} from '@image-playground/shared'
import { Type } from 'typebox'
import { isCapabilityEnabled } from '../../capabilities'
import { requireAgentImages } from '../images'
import { defineAgentTool } from './adapter'
import { AgentToolError } from './errors'
import { reviewParameter } from './queueParams'
import { noModelMessage, type QueueTarget, resolveAgentModel, runQueueTask } from './queueTask'

const TITLE_MAX_CHARS = 32

/**
 * 给视频产物记下实际提交的档位与模型：画布据此「改一个参数重来」和续写。
 * 记的是补齐后的档位，不是模型请求的原值——用户看到的应当是真正生成它的那一套。
 */
export function withVideoRecord(
  artifacts: readonly AgentToolArtifact[],
  model: string,
  preset: VideoPreset,
  firstFrameId: string | null,
): AgentToolArtifact[] {
  const video = videoRecord(model, preset, firstFrameId)
  return artifacts.map((artifact) =>
    artifact.media === 'video' ? { ...artifact, video } : artifact,
  )
}

function videoRecord(
  model: string,
  preset: VideoPreset,
  firstFrameId: string | null,
): VideoGenerationRecord {
  return {
    model,
    duration: preset.duration,
    aspectRatio: preset.aspectRatio,
    resolution: preset.resolution,
    ...(firstFrameId ? { firstFrameId } : {}),
  }
}

/**
 * 能跑的视频模型：既要在这个部署的 channel 里，也要在支持矩阵里。
 * 少判一半，工具就会进模型的清单，然后在执行时抛——那一轮直接死掉。
 */
function videoModel(): { target: QueueTarget; support: VideoModelSupport } | null {
  const target = resolveAgentModel('video')
  const support = target ? VIDEO_MODEL_SUPPORT[target.model] : undefined
  return target && support ? { target, support } : null
}

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
    prompt: Type.String({
      description: '描述这段视频里发生什么：主体、动作、镜头怎么动。用用户说话的语言写。',
    }),
    imageId: Type.Optional(
      Type.String({
        description:
          '要动起来的那张图的图片 id，视频从它开始，产出也放在它旁边。不填就是纯文生视频。',
      }),
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

const GUIDANCE_BASE = '用户要让画面动起来时调生视频工具；视频慢也贵，他没明说要视频就别自作主张。'

function videoGuidance(): string {
  const support = videoModel()?.support
  if (!support) return GUIDANCE_BASE
  return `${GUIDANCE_BASE}这个部署的视频模型是 ${support.label}：${supportText(support)}。用户明说的档位它做不到时，工具不会提交、也不会替他换一档——按工具回执里的支持范围跟用户确认，或者改用支持的值重试。`
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

/** 提交出去的到底是哪一档。模型没填的项按矩阵退档，退到哪也要说出口，不能只有我们知道。 */
function submittedText(support: VideoModelSupport, preset: VideoPreset): string {
  return `实际提交的档位：${preset.duration} 秒 / ${VIDEO_RESOLUTION_LABELS[preset.resolution]} / ${preset.aspectRatio}（${support.label}，${supportText(support)}）。用户没指定的项由这个模型的矩阵补齐；回复时如实说你替他定了什么。`
}

/** 模型填的档位里，这个部署做不到的那几项。`call()` 与 `execute()` 同一个算式。 */
function conflictsFor(args: {
  readonly durationSeconds?: number | undefined
  readonly resolution?: VideoPreset['resolution'] | undefined
  readonly aspectRatio?: VideoPreset['aspectRatio'] | undefined
}): VideoPresetConflict[] {
  const resolved = videoModel()
  if (!resolved) return []
  return videoPresetConflicts(resolved.support, {
    duration: args.durationSeconds,
    aspectRatio: args.aspectRatio,
    resolution: args.resolution,
  })
}

export const generateVideo = defineAgentTool({
  name: 'generateVideo',
  // 只在视频轮：图片轮里出现它，模型就会把「让它动起来」当成随时可选的下一步。
  modes: ['video'],
  label: '生视频',
  description:
    '生成一段视频。提交后立即返回「已提交」，视频在后台生成，完成后自动落到用户的画布上，带封面可播放；返回时结果尚未就绪。给了图片 id 就从那张图动起来，不给就按提示词凭空生成。视频比图片慢得多也贵得多，用户明确要视频时才调。',
  guidance: videoGuidance,
  // 静态的那份只在解析不出模型时用得上（那时工具本来就不在清单里），形状由它定型。
  parameters: videoParameters(null),
  currentParameters: () => videoParameters(videoModel()?.support ?? null),
  // 视频是这里最贵的一件事，失败让模型接着重试等于再扣一次费；停下来交给用户定夺。
  onError: 'abort',
  available: () => isCapabilityEnabled('generation:video') && videoModel() !== null,
  target: () => videoModel()?.target,
  call({ prompt, imageId, durationSeconds, resolution, aspectRatio }) {
    const written = typeof prompt === 'string' ? prompt : undefined
    // 档位做不到就不提交，也就不会有产物。画布跟着不占位——`outputCount` 必须与真正提交的
    // 张数同一个算式，否则那里会空出一个永远填不上的框。
    const refused = conflictsFor({ durationSeconds, resolution, aspectRatio }).length > 0
    return {
      title: written?.trim() ? `视频：${agentTitleLine(written, TITLE_MAX_CHARS)}` : '生视频',
      // 视频任务一次只出一段，图片参数里的 n 对它没有意义。
      ...(refused ? {} : { outputCount: 1 }),
      // 给了起始帧就贴着它放——与执行时的 `anchorObjectId` 取同一项。
      ...(typeof imageId === 'string' && imageId ? { anchor: imageId, references: [imageId] } : {}),
      ...(written ? { prompt: written } : {}),
    }
  },
  execute(context) {
    return async (toolCallId, params, signal) => {
      const resolved = videoModel()
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
      const preset = clampVideoPreset(support, asked)
      const source = params.imageId
        ? (await requireAgentImages(context.images, [params.imageId]))[0]!
        : null
      const outcome = await runQueueTask(
        context,
        {
          media: 'video',
          toolCallId,
          target,
          prompt: params.prompt,
          ...(source ? { inputImages: [source.dataUrl] } : {}),
          video: {
            duration_seconds: preset.duration,
            aspect_ratio: preset.aspectRatio,
            resolution: preset.resolution,
            ...(source ? { first_frame_index: 0 } : {}),
          },
          ...(source ? { anchorObjectId: source.imageId } : {}),
          review: params.reviewAfterCompletion === true,
        },
        signal,
      )
      // 结果块只读 `details`，所以多这一段文字不动前端协议：它只进模型的上下文。
      const job = outcome.details?.job
      return {
        ...outcome,
        // 档位记在任务上：产物要等任务结束才有，那时再照它记到产物上。
        ...(job
          ? {
              details: {
                ...outcome.details,
                job: {
                  ...job,
                  video: videoRecord(target.model, preset, source?.imageId ?? null),
                },
              },
            }
          : {}),
        ...(outcome.details?.artifacts
          ? {
              details: {
                ...outcome.details,
                artifacts: withVideoRecord(
                  outcome.details.artifacts,
                  target.model,
                  preset,
                  source?.imageId ?? null,
                ),
              },
            }
          : {}),
        content: [...outcome.content, { type: 'text', text: submittedText(support, preset) }],
      }
    }
  },
})
