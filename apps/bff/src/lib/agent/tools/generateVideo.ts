import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { VideoAspectRatio, VideoDuration, VideoResolution } from '@image-playground/shared'
import {
  agentTitleLine,
  clampToSupported,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DEFAULT_ASPECT_RATIO,
  VIDEO_DEFAULT_DURATION,
  VIDEO_DEFAULT_RESOLUTION,
  VIDEO_DURATIONS,
  VIDEO_MODEL_SUPPORT,
  VIDEO_RESOLUTIONS,
  videoDurationsForResolution,
} from '@image-playground/shared'
import { Type } from 'typebox'
import { isCapabilityEnabled } from '../../capabilities'
import { resolveAgentModel, runQueueTask } from './queueTask'
import type { AgentToolContext, AgentToolDefinition, AgentToolDetails } from './types'

const TITLE_MAX_CHARS = 32

const parameters = Type.Object({
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
    Type.Number({
      description: `视频时长（秒），可选 ${VIDEO_DURATIONS.join(' / ')}。用户没说就别填。`,
    }),
  ),
  resolution: Type.Optional(
    Type.Union(
      VIDEO_RESOLUTIONS.map((value) => Type.Literal(value)),
      { description: '清晰度。用户没说就别填。' },
    ),
  ),
  aspectRatio: Type.Optional(
    Type.Union(
      VIDEO_ASPECT_RATIOS.map((value) => Type.Literal(value)),
      { description: '画幅。用户没说就别填；说了竖屏就填 9:16。' },
    ),
  ),
})

function title(args: unknown): string {
  const prompt = (args as { prompt?: unknown } | null)?.prompt
  return typeof prompt === 'string' && prompt.trim()
    ? `视频：${agentTitleLine(prompt, TITLE_MAX_CHARS)}`
    : '生视频'
}

interface Preset {
  readonly duration: VideoDuration
  readonly aspectRatio: VideoAspectRatio
  readonly resolution: VideoResolution
}

/**
 * 模型可以说任意档位，落到这个部署的视频模型支持不了的值上就退档。
 * 清晰度是主轴：时长按清晰度退，反过来会把清晰度顶掉。
 */
function presetFor(
  modelId: string,
  asked: {
    duration?: number | undefined
    aspectRatio?: VideoAspectRatio | undefined
    resolution?: VideoResolution | undefined
  },
): Preset {
  const support = VIDEO_MODEL_SUPPORT[modelId]
  if (!support) throw new Error('暂时没有可用的生视频模型')
  const resolution = clampToSupported(
    support.resolutions,
    asked.resolution ?? VIDEO_DEFAULT_RESOLUTION,
  )
  return {
    resolution,
    duration: clampToSupported(
      videoDurationsForResolution(support, resolution),
      (asked.duration ?? VIDEO_DEFAULT_DURATION) as VideoDuration,
    ),
    aspectRatio: clampToSupported(
      support.aspectRatios,
      asked.aspectRatio ?? VIDEO_DEFAULT_ASPECT_RATIO,
    ),
  }
}

async function firstFrame(context: AgentToolContext, imageId: string): Promise<string> {
  const image = await context.images.resolve(imageId)
  // 模型会顺着历史里的图片 id 猜，猜错时它得知道该让用户去输入框引用那张图。
  if (!image) throw new Error(`拿不到图片 ${imageId}，请让用户在输入框里引用它`)
  return image.dataUrl
}

export const generateVideo: AgentToolDefinition = {
  name: 'generateVideo',
  title,
  // 视频是这里最贵的一件事，失败让模型接着重试等于再扣一次费；停下来交给用户定夺。
  onError: 'abort',
  available: () => isCapabilityEnabled('generation:video'),
  create(context) {
    const tool: AgentTool<typeof parameters, AgentToolDetails> = {
      name: 'generateVideo',
      label: '生视频',
      description:
        '生成一段视频，产出直接落到用户的画布上，带封面可播放。给了图片 id 就从那张图动起来，不给就按提示词凭空生成。视频比图片慢得多也贵得多，用户明确要视频时才调。',
      parameters,
      async execute(_toolCallId, params, signal, onUpdate) {
        const target = resolveAgentModel('video')
        if (!target) throw new Error('暂时没有可用的生视频模型')
        const preset = presetFor(target.model, {
          duration: params.durationSeconds,
          aspectRatio: params.aspectRatio,
          resolution: params.resolution,
        })
        const source = params.imageId ? await firstFrame(context, params.imageId) : null
        return runQueueTask(
          context,
          {
            media: 'video',
            prompt: params.prompt,
            ...(source ? { inputImages: [source] } : {}),
            video: {
              duration_seconds: preset.duration,
              aspect_ratio: preset.aspectRatio,
              resolution: preset.resolution,
              ...(source ? { first_frame_index: 0 } : {}),
            },
            ...(params.imageId ? { anchorImageId: params.imageId } : {}),
          },
          signal,
          onUpdate,
        )
      },
    }
    return tool as AgentTool
  },
}
