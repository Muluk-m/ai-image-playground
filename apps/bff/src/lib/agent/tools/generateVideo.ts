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
import { defineAgentTool } from './adapter'
import { noModelMessage, type QueueTarget, resolveAgentModel, runQueueTask } from './queueTask'

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

/**
 * 能跑的视频模型：既要在这个部署的 channel 里，也要在支持矩阵里。
 * 少判一半，工具就会进模型的清单，然后在执行时抛——那一轮直接死掉。
 */
function videoModel(): { target: QueueTarget; support: VideoModelSupport } | null {
  const target = resolveAgentModel('video')
  const support = target ? VIDEO_MODEL_SUPPORT[target.model] : undefined
  return target && support ? { target, support } : null
}

export const generateVideo = defineAgentTool({
  name: 'generateVideo',
  label: '生视频',
  description:
    '生成一段视频，产出直接落到用户的画布上，带封面可播放。给了图片 id 就从那张图动起来，不给就按提示词凭空生成。视频比图片慢得多也贵得多，用户明确要视频时才调。',
  guidance: '用户要让画面动起来时调生视频工具；视频慢也贵，他没明说要视频就别自作主张。',
  parameters,
  // 视频是这里最贵的一件事，失败让模型接着重试等于再扣一次费；停下来交给用户定夺。
  onError: 'abort',
  available: () => isCapabilityEnabled('generation:video') && videoModel() !== null,
  call({ prompt, imageId }) {
    const written = typeof prompt === 'string' ? prompt : undefined
    return {
      title: written?.trim() ? `视频：${agentTitleLine(written, TITLE_MAX_CHARS)}` : '生视频',
      // 视频任务一次只出一段，图片参数里的 n 对它没有意义。
      outputCount: 1,
      // 给了起始帧就贴着它放——与执行时的 `anchorObjectId` 取同一项。
      ...(typeof imageId === 'string' && imageId ? { anchor: imageId } : {}),
      ...(written ? { prompt: written } : {}),
    }
  },
  execute(context) {
    return async (_toolCallId, params, signal, onUpdate) => {
      const resolved = videoModel()
      if (!resolved) throw new Error(noModelMessage('video'))
      const preset = clampVideoPreset(resolved.support, {
        duration: params.durationSeconds,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
      })
      const source = params.imageId
        ? (await requireAgentImages(context.images, [params.imageId]))[0]!
        : null
      return runQueueTask(
        context,
        {
          media: 'video',
          target: resolved.target,
          prompt: params.prompt,
          ...(source ? { inputImages: [source.dataUrl] } : {}),
          video: {
            duration_seconds: preset.duration,
            aspect_ratio: preset.aspectRatio,
            resolution: preset.resolution,
            ...(source ? { first_frame_index: 0 } : {}),
          },
          ...(source ? { anchorObjectId: source.imageId } : {}),
        },
        signal,
        onUpdate,
      )
    }
  },
})
