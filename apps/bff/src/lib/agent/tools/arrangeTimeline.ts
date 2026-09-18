import {
  type AgentTimelineClip,
  type AgentTimelinePlan,
  PROJECT_TIMELINE_MAX_CLIPS,
  parseProjectArtifactId,
} from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { Type } from 'typebox'
import { db, schema } from '../../../db/client'
import { defineAgentTool } from './adapter'
import type { AgentToolContext } from './types'

const parameters = Type.Object({
  clips: Type.Array(
    Type.Object({
      videoId: Type.String({
        description: '视频产物 id（生视频工具出片后结果里的那个 id），按成片里的先后顺序排。',
      }),
      inSeconds: Type.Optional(
        Type.Number({ minimum: 0, description: '这一段从第几秒开始，缺省从头。' }),
      ),
      outSeconds: Type.Optional(
        Type.Number({ minimum: 0, description: '这一段到第几秒结束，缺省到结尾。' }),
      ),
    }),
    { minItems: 1, maxItems: PROJECT_TIMELINE_MAX_CLIPS },
  ),
})

/**
 * 按产物 id 找回这个会话里智能体出完的那段视频和它的时长。找不到、不是视频、没出完、
 * 不是这个会话提交的都不认——时间线只排这一路真实出完的片子。
 */
async function finishedVideoSeconds(
  context: AgentToolContext,
  videoId: string,
): Promise<number | null> {
  const artifact = parseProjectArtifactId(videoId)
  // 视频任务只出一段。
  if (!artifact || artifact.position !== 0) return null
  const [task] = await db
    .select({
      status: schema.tasks.status,
      user_id: schema.tasks.user_id,
      request: schema.tasks.request_payload,
    })
    .from(schema.tasks)
    .innerJoin(schema.agent_jobs, eq(schema.agent_jobs.task_id, schema.tasks.id))
    .where(
      and(
        eq(schema.tasks.id, artifact.generationId),
        eq(schema.agent_jobs.conversation_id, context.conversationId),
      ),
    )
  const video = task?.request.video
  if (!task || !video || task.status !== 'completed') return null
  const owned = context.userId
    ? task.user_id === context.userId
    : task.user_id === null && task.request.device_id === context.deviceId
  return owned ? video.duration_seconds : null
}

/** 入出点收进这段片子的时长里；出点不在入点之后就播到结尾。入点已到结尾时这段排不出来。 */
function clipOf(
  videoId: string,
  seconds: number,
  inSeconds: number | undefined,
  outSeconds: number | undefined,
): AgentTimelineClip | null {
  const start = Math.max(0, inSeconds ?? 0)
  if (start >= seconds) return null
  const end = outSeconds === undefined ? seconds : Math.min(outSeconds, seconds)
  return { videoId, in: start, out: end > start ? end : seconds }
}

export const arrangeTimeline = defineAgentTool({
  name: 'arrangeTimeline',
  // 只在视频轮：排的是这一轮出的片子。
  modes: ['video'],
  label: '排进时间线',
  description:
    '把已经出完的几段视频按顺序排进画布上的一条新时间线，用户可以直接预览和导出成片。不花积分，不生成任何东西；只排真正出完的片子，失败的镜头不要放进来。',
  guidance: () =>
    '按镜头出片时，等每段视频都出完（后台任务结束会唤醒你），再用排进时间线工具把成功的那些按镜头顺序排好；某段失败就跳过它，并在回复里说清是哪一段没出来。',
  parameters,
  onError: 'continue',
  // 不落图，不占位：时间线由画布在工具结束后按结果建出来。
  call: ({ clips }) => ({
    title: Array.isArray(clips) ? `时间线：${clips.length} 段` : '排进时间线',
  }),
  execute: (context) => async (_toolCallId, params) => {
    const clips: AgentTimelineClip[] = []
    const skipped: string[] = []
    const empty: string[] = []
    for (const one of params.clips) {
      const seconds = await finishedVideoSeconds(context, one.videoId)
      const clip =
        seconds === null ? null : clipOf(one.videoId, seconds, one.inSeconds, one.outSeconds)
      if (clip) clips.push(clip)
      else (seconds === null ? skipped : empty).push(one.videoId)
    }
    const skippedLine =
      (skipped.length ? `这些 id 不是本会话出完的视频，没有排进去：${skipped.join('、')}。` : '') +
      (empty.length ? `这些片段的入点已经到了结尾，没有排进去：${empty.join('、')}。` : '')
    if (clips.length === 0)
      return {
        content: [{ type: 'text', text: `没有可以排的视频。${skippedLine}` }],
        details: {},
      }
    const timeline: AgentTimelinePlan = { timelineId: `timeline_${crypto.randomUUID()}`, clips }
    const total = clips.reduce((sum, clip) => sum + clip.out - clip.in, 0)
    return {
      content: [
        {
          type: 'text',
          text: `已在画布上排好一条时间线：${clips.length} 段，共约 ${Math.round(total)} 秒，用户可以直接预览和导出成片。${skippedLine}`,
        },
      ],
      details: { timeline },
    }
  },
})
