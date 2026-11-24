import {
  type AgentToolArtifact,
  type AgentToolName,
  type ChannelMedia,
  type ImagePresetRatio,
  type PersistedVideoRequest,
  projectArtifactId,
  type QueueProvider,
  type VideoGenerationRecord,
} from '@image-playground/shared'
import type { ExtractedResult } from '../../../lib/extractImages'
import type { MaskedEditContent, MaskedOperation } from './tool-ports'

export interface QueueMediaWords {
  readonly verb: string
  readonly unit: string
}

export const QUEUE_MEDIA_WORDS: Record<ChannelMedia, QueueMediaWords> = {
  image: { verb: '生图', unit: '张图' },
  video: { verb: '生视频', unit: '段视频' },
}

export interface QueueTarget {
  readonly provider: QueueProvider
  readonly model: string
}

export interface QueueTaskInput {
  readonly toolName: AgentToolName
  readonly toolCallId?: string
  readonly maskedOperation?: MaskedOperation
  /** 这次真遮罩编辑的内容身份；缺席即这次提交不参与内容去重。 */
  readonly maskedContent?: MaskedEditContent
  readonly media: ChannelMedia
  /** 已经解析好的模型；缺席就按介质现解析。 */
  readonly target?: QueueTarget
  readonly prompt: string
  /** 图片工具选择的产出张数。缺席时 {@link draftQueueTask} 沿用用户本轮选择的张数。 */
  readonly n?: number
  /** 模型按用户原话指定的比例；缺席即沿用轮参数里的尺寸。 */
  readonly aspectRatio?: ImagePresetRatio
  readonly referenceIds?: readonly string[]
  readonly inputImages?: readonly string[]
  readonly mask?: string
  /** 视频档位；缺席即这是一条图片任务。 */
  readonly video?: PersistedVideoRequest
  /** 视频产物要标注的档位与来源图；确认提交时随任务记下。 */
  readonly videoRecord?: VideoGenerationRecord
  /** 产出落画布时贴着这个画布对象放。 */
  readonly anchorObjectId?: string
  /**
   * 成功后要不要唤醒智能体回来复核（失败一律唤醒）。模型在拟稿时自己选；局部改图的候选
   * 必须复核，由改图工具定死。
   */
  readonly review?: boolean
}

/**
 * 确认门续跑时接在历史末尾的回执（见 `tool-gate.ts`）：拦下那一刻交给模型的那一句原样接回
 * （版本数、尺寸都在里面），只在末尾补上用户确认的提示词——他可能在卡上改过。
 * 没留原文的旧卡退回不带数量与尺寸的同一种说法。
 */
export function confirmedSubmissionText(
  media: ChannelMedia,
  prompt: string | undefined,
  receipt?: string,
): string {
  const executed = prompt ? `执行提示词：${prompt}。` : ''
  if (receipt) return `${receipt}${executed}`
  const words = QUEUE_MEDIA_WORDS[media]
  return `已按用户要求提交${words.verb}任务，这次调用已经提交并计费，结果会显示在对话的产物卡片中。${executed}不要描述成品的样子，也不要为同一件事再提交一次；结果由系统在任务结束时告诉你。`
}

/**
 * 上游出事、运营配置的生图模型被暂停时优先换到的那一个：走 Vertex，和 sub2api 的账号池互不相干
 * （2026-10-29 flare 事故）。没加载这个模型的部署照常落到第一个可用的。
 */
export const AGENT_IMAGE_FALLBACK_MODEL = 'gemini-nano-banana-2.1'

/** 没有可用模型时的那一句；工具的可用性判定与执行都从这里拿，两处不会各说各的。 */
export function noModelMessage(media: ChannelMedia): string {
  return `暂时没有可用的${QUEUE_MEDIA_WORDS[media].verb}模型`
}

/** 一条跑完的队列任务落成的产物。同步等结果与后台任务结算走同一个算式。 */
export function queueArtifacts(
  taskId: string,
  media: ChannelMedia,
  result: ExtractedResult,
): AgentToolArtifact[] {
  return result.images.map((output) => ({
    // 画布对象与结果卡共用这个 id，点卡才能定位到同一个对象。
    artifactId: projectArtifactId(taskId, output.index),
    media,
    taskId,
    outputIndex: output.index,
    mime: output.mime,
    ...(output.width !== undefined ? { width: output.width } : {}),
    ...(output.height !== undefined ? { height: output.height } : {}),
  }))
}
