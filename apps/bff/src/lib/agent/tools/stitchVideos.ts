import type { AgentToolArtifact } from '@image-playground/shared'
import { agentTitleLine } from '@image-playground/shared'
import { Type } from 'typebox'
import { isCapabilityEnabled } from '../../capabilities'
import { isFfmpegAvailable } from '../../ffmpeg'
import type { AgentVideoLookup, ResolvedAgentVideo } from '../images'
import { stitchVideoSegments } from '../video-stitch'
import { STITCH_LIMITS, type StitchAdaptation } from '../video-stitch-plan'
import { defineAgentTool } from './adapter'

const TITLE_MAX_CHARS = 32

/** 模型给的参数这一刻还没被 pi 校验过，所以这里只认「真的是一串非空字符串」。 */
function videoIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((one): one is string => typeof one === 'string' && one.trim().length > 0)
}

const parameters = Type.Object({
  videoIds: Type.Array(Type.String(), {
    description: `要接起来的视频 id，**按播放顺序排**，至少 ${STITCH_LIMITS.minSegments} 段、最多 ${STITCH_LIMITS.maxSegments} 段。只能填这一轮对话里已经出片的视频 id。`,
    minItems: STITCH_LIMITS.minSegments,
    maxItems: STITCH_LIMITS.maxSegments,
  }),
  title: Type.Optional(Type.String({ description: '成片的名字，一句话。用用户说话的语言写。' })),
})

const GUIDANCE = `各镜都出完之后，在同一轮里调拼接工具把它们接成一条成片交付，不要让用户自己去接，也不要等他说「继续」。拼接不花钱、不调模型：它把已经出好的几段按你给的顺序重编码接起来，成片照常落画布。分辨率取第一段，画幅不同的段会补黑边——工具回执里逐段写明它被怎么适配了，如实转达给用户。一次最多 ${STITCH_LIMITS.maxSegments} 段、总时长 ${STITCH_LIMITS.maxTotalSeconds} 秒、整次最多跑 ${Math.round(STITCH_LIMITS.totalBudgetMs / 1000)} 秒，一轮里最多拼 ${STITCH_LIMITS.maxPerTurn} 次。超了工具会如实说，分批拼再把成片接起来——成片本身也可以当一段接着拼。`

/** 逐段说清它是怎么被接进去的。用户看得见这句话，所以「补了黑边」不能藏着。 */
function adaptationLines(
  videos: readonly ResolvedAgentVideo[],
  adaptations: readonly StitchAdaptation[],
): string[] {
  return adaptations.map((one) => {
    const notes: string[] = []
    if (one.padded) notes.push('画幅与第一段不同，两侧补了黑边')
    else if (one.scaled) notes.push('分辨率与第一段不同，已缩放')
    if (one.silenced) notes.push('本来没有音轨，补了等长静音')
    const id = videos[one.index]?.videoId ?? ''
    return `- 第 ${one.index + 1} 段（${id}）：${notes.length ? notes.join('；') : '原样接入'}`
  })
}

/** 引用取不到时的回执。**不抛**：抛了模型只会换一个 id 再撞一次，不如把实情摆出来。 */
function lookupRefusal(
  failures: readonly { readonly videoId: string; readonly kind: 'unknown' | 'unavailable' }[],
  known: readonly string[],
): string {
  const lines = failures.map((one) =>
    one.kind === 'unknown'
      ? `- ${one.videoId}：这一轮对话里没有这个视频 id`
      : `- ${one.videoId}：这段视频还取不出来（可能还没跑完，或者不属于当前用户）`,
  )
  return [
    '没有拼接：下面这些视频取不到。',
    ...lines,
    known.length
      ? `这一轮可用的视频 id：${known.join('、')}。核对后重试。`
      : '这一轮还没有出片，先把各镜的视频生成出来再拼。',
  ].join('\n')
}

export const stitchVideos = defineAgentTool({
  name: 'stitchVideos',
  // 只在视频轮：图片轮里连视频都出不了，更没有几段可接。
  modes: ['video'],
  label: '拼接视频',
  description:
    '把这一轮已经出好的多段视频按给定顺序接成一条完整成片，成片照常落到用户的画布上，带封面可播放。不调用任何生成模型，也不消耗积分。各镜都出完之后就调它交付成片。',
  guidance: GUIDANCE,
  parameters,
  // 拼接不花钱，失败让模型换个顺序或换几段重试是划算的；不该为它把整轮停掉。
  onError: 'continue',
  // 三重门禁：视频轮（modes）、这个部署出得了视频、这台机器真有 ffmpeg。
  available: () => isCapabilityEnabled('generation:video') && isFfmpegAvailable(),
  call({ videoIds, title }) {
    const ids = videoIdsOf(videoIds)
    const written = typeof title === 'string' ? title.trim() : ''
    return {
      title: written ? `拼接：${agentTitleLine(written, TITLE_MAX_CHARS)}` : '拼接视频',
      // 段数不够就不会提交，也就没有产物；画布跟着不占位，否则那里会空出一个填不上的框。
      ...(ids.length >= STITCH_LIMITS.minSegments ? { outputCount: 1 } : {}),
      // 成片贴着第一段放。
      ...(ids[0] ? { anchor: ids[0] } : {}),
    }
  },
  execute(context) {
    // 一轮里拼几次有上限：闭包跟着这一轮的工具实例活，轮结束就随它一起没了——
    // 不用另立一张按 turnId 索引、还得自己清理的表。
    let ran = 0
    return async (_toolCallId, params, signal, onUpdate) => {
      if (ran >= STITCH_LIMITS.maxPerTurn) {
        return {
          content: [
            {
              type: 'text',
              text: `这一轮已经拼过 ${ran} 次，到了 ${STITCH_LIMITS.maxPerTurn} 次的上限。把已经交付的成片告诉用户，要再拼请他开新的一轮。`,
            },
          ],
          details: {},
        }
      }
      const ids = videoIdsOf(params.videoIds)
      if (ids.length < STITCH_LIMITS.minSegments) {
        return {
          content: [
            {
              type: 'text',
              text: `没有拼接：至少要 ${STITCH_LIMITS.minSegments} 段视频，这次只给了 ${ids.length} 段。`,
            },
          ],
          details: {},
        }
      }
      const lookups = await Promise.all(
        ids.map(
          async (id): Promise<[string, AgentVideoLookup]> => [
            id,
            await context.images.resolveVideo(id),
          ],
        ),
      )
      const failures = lookups
        .filter(([, lookup]) => lookup.kind !== 'ready')
        .map(([videoId, lookup]) => ({ videoId, kind: lookup.kind as 'unknown' | 'unavailable' }))
      if (failures.length > 0) {
        return {
          content: [{ type: 'text', text: lookupRefusal(failures, context.images.videoIds) }],
          details: {},
        }
      }
      // 顺序就是模型给的顺序：拼接唯一不能自作主张的就是它。
      const videos = lookups.map(([, lookup]) =>
        lookup.kind === 'ready' ? lookup.video : null,
      ) as ResolvedAgentVideo[]
      const written = typeof params.title === 'string' ? params.title.trim() : ''
      // 落库的那一份与卡片标题同一条截断规则：`request_payload.prompt` 不该收下一篇作文。
      const title = written ? agentTitleLine(written, TITLE_MAX_CHARS) : '拼接成片'
      // 真要起 ffmpeg 了才记一次：参数不合法、引用取不到这些回执不吃 CPU，不该占名额。
      ran++
      const outcome = await stitchVideoSegments({
        videos,
        userId: context.userId,
        deviceId: context.deviceId,
        conversationId: context.conversationId,
        turnId: context.turnId,
        title,
        ...(signal ? { signal } : {}),
        onQueued: () => onUpdate?.({ content: [], details: { stage: 'submitted' } }),
        onRunning: () => onUpdate?.({ content: [], details: { stage: 'running' } }),
      })
      if (outcome.kind !== 'stitched') {
        return { content: [{ type: 'text', text: outcome.message }], details: {} }
      }
      const artifact: AgentToolArtifact = {
        artifactId: `agent_${crypto.randomUUID()}`,
        media: 'video',
        taskId: outcome.taskId,
        outputIndex: outcome.outputIndex,
        mime: outcome.mime,
        width: outcome.width,
        height: outcome.height,
      }
      context.images.note([artifact])
      return {
        content: [
          {
            type: 'text',
            text: [
              `已把 ${videos.length} 段接成一条 ${outcome.durationSeconds.toFixed(1)} 秒的视频并放到画布上，视频 id：${artifact.artifactId}。`,
              `成片 ${outcome.width}×${outcome.height}，按第一段的分辨率与画幅。逐段情况：`,
              ...adaptationLines(videos, outcome.adaptations),
              '这一步没有调用任何生成模型，不消耗积分。',
            ].join('\n'),
          },
        ],
        details: {
          artifacts: [artifact],
          ...(videos[0] ? { anchorObjectId: videos[0].videoId } : {}),
        },
      }
    }
  },
})
