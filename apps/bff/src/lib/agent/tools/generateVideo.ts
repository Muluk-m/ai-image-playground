import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { VideoModelSupport } from '@image-playground/shared'
import {
  agentTitleLine,
  clampVideoPreset,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_MODEL_SUPPORT,
  VIDEO_RESOLUTIONS,
} from '@image-playground/shared'
import { Type } from 'typebox'
import { isCapabilityEnabled } from '../../capabilities'
import { requireAgentImages } from '../images'
import { noModelMessage, type QueueTarget, resolveAgentModel, runQueueTask } from './queueTask'
import type { AgentToolDefinition, AgentToolDetails } from './types'

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

/**
 * 能跑的视频模型：既要在这个部署的 channel 里，也要在支持矩阵里。
 * 少判一半，工具就会进模型的清单，然后在执行时抛——那一轮直接死掉。
 */
function videoModel(): { target: QueueTarget; support: VideoModelSupport } | null {
  const target = resolveAgentModel('video')
  const support = target ? VIDEO_MODEL_SUPPORT[target.model] : undefined
  return target && support ? { target, support } : null
}

export const generateVideo: AgentToolDefinition = {
  name: 'generateVideo',
  guidance: '用户要让画面动起来时调生视频工具；视频慢也贵，他没明说要视频就别自作主张。',
  title,
  // 视频是这里最贵的一件事，失败让模型接着重试等于再扣一次费；停下来交给用户定夺。
  onError: 'abort',
  available: () => isCapabilityEnabled('generation:video') && videoModel() !== null,
  create(context) {
    const tool: AgentTool<typeof parameters, AgentToolDetails> = {
      name: 'generateVideo',
      label: '生视频',
      description:
        '生成一段视频，产出直接落到用户的画布上，带封面可播放。给了图片 id 就从那张图动起来，不给就按提示词凭空生成。视频比图片慢得多也贵得多，用户明确要视频时才调。',
      parameters,
      async execute(_toolCallId, params, signal, onUpdate) {
        const resolved = videoModel()
        if (!resolved) throw new Error(noModelMessage('video'))
        const preset = clampVideoPreset(resolved.support, {
          duration: params.durationSeconds,
          aspectRatio: params.aspectRatio,
          resolution: params.resolution,
        })
        const source = params.imageId
          ? (await requireAgentImages(context.images, [params.imageId]))[0]!.dataUrl
          : null
        return runQueueTask(
          context,
          {
            media: 'video',
            target: resolved.target,
            prompt: params.prompt,
            ...(source ? { inputImages: [source] } : {}),
            video: {
              duration_seconds: preset.duration,
              aspect_ratio: preset.aspectRatio,
              resolution: preset.resolution,
              ...(source ? { first_frame_index: 0 } : {}),
            },
            ...(params.imageId ? { anchorObjectId: params.imageId } : {}),
          },
          signal,
          onUpdate,
        )
      },
    }
    return tool as AgentTool
  },
}
