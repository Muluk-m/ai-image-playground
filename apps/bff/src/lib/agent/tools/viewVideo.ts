import { Type } from 'typebox'
import { readVideoClip } from '../video-clip'
import { sampleVideo, VideoUnreadable } from '../video-frames'
import { prepareVisualEvidence } from '../visual-input'
import { currentVisualSignal, withVisualPreparation } from '../visual-resources'
import { defineAgentTool } from './adapter'
import type { AgentToolContext } from './types'

const parameters = Type.Object({
  videoId: Type.String({
    minLength: 1,
    description: '视频 id，形如 agent_任务_序号。封面图片 id 不是这个。一次只看一段。',
  }),
})

function formatSeconds(value: number): string {
  const rounded = Math.round(value * 1000) / 1000
  return String(rounded)
}

function stillsText(frameCount: number, times: readonly number[], intervalSeconds: number): string {
  const stamps = times.map((time) => `t=${formatSeconds(time)}s`).join('、')
  const every = Math.round(intervalSeconds * 1000) / 1000
  const spacing =
    frameCount === 1 || every === 0
      ? '片子很短，只取到开头这一帧'
      : every === 1
        ? '大约每秒 1 帧'
        : `大约每 ${formatSeconds(every)} 秒 1 帧`
  return `已从这段视频抽出 ${frameCount} 张静帧（${stamps}），${spacing}。这些是画面的静帧，不是成片本身：两帧之间的运动没有看到，也没有听到音轨。不要把静帧之间的变化说成连续动作，也不要编造对白或声音。`
}

async function look(context: AgentToolContext, videoId: string) {
  return withVisualPreparation(async () => {
    const clip = await readVideoClip(context, videoId, currentVisualSignal())
    if (!clip.ok) return { text: clip.message, images: [] }
    try {
      const sampled = await sampleVideo(clip.bytes, clip.durationSeconds, currentVisualSignal())
      const evidence = await prepareVisualEvidence(
        sampled.frames.map((frame) => ({
          imageId: `${clip.videoId}@${frame.timeSeconds}`,
          dataUrl: `data:image/jpeg;base64,${Buffer.from(frame.jpeg).toString('base64')}`,
          visualVariant: 'preview' as const,
        })),
        'viewVideo',
        'preview',
      )
      return {
        text: `${stillsText(
          sampled.frames.length,
          sampled.frames.map((frame) => frame.timeSeconds),
          sampled.intervalSeconds,
        )}${evidence.manifest}`,
        images: evidence.content,
      }
    } catch (error) {
      if (error instanceof VideoUnreadable) return { text: error.userMessage, images: [] }
      throw error
    }
  })
}

export const viewVideo = defineAgentTool({
  name: 'viewVideo',
  modes: ['image', 'video'],
  label: '看视频',
  description:
    '按视频 id 看一段已经出完的视频的画面。一次只看一段。对话模型收不到视频文件，所以按时间抽出少量带时间戳的静帧：短片大约每秒 1 帧，更长的均匀取最多 8 帧，长边缩到预览大小。这些是静帧，看不到两帧之间的运动，也听不到声音。封面图片 id 不是视频。',
  guidance:
    '要看已生成视频的画面，用 viewVideo 按视频 id 抽静帧。那是间隔取样的静帧，看不到两帧之间的运动，也听不到音轨，不要声称看过动作或对白。封面只是第一帧。',
  parameters,
  onError: 'continue',
  call: () => ({ title: '看视频' }),
  execute: (context) => async (_toolCallId, params) => {
    const { text, images } = await look(context, params.videoId.trim())
    return { content: [{ type: 'text' as const, text }, ...images], details: {} }
  },
})
