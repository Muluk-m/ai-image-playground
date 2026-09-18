import type { AgentToolErrorCode } from '@image-playground/shared'
import {
  AGENT_RETRYABLE_ERROR_CODES,
  agentToolRetryable,
  videoRateMultiplier,
} from '@image-playground/shared'
import { getStoredChannels } from '../../../lib/channels/channelStore'
import type { PrivateSubmissionInput } from '../../../lib/privateOverlay'
import type { AgentPanelMessage, AgentToolMessage } from '../types'

/**
 * 单张重试的前端判据。能不能重试只按结构化的几位判（ADR 0006）：失败占位此刻的错误码、
 * 原失败卡的资格（`agentToolRetryable`），以及快照里那个模型此刻还在不在清单上。
 */

/** 失败占位上认得出它属于哪次调用的那几位。 */
export interface AgentRetryPlaceholder {
  /** 本机占位：起跑时那张结果卡的消息 id。 */
  readonly agentMessageId?: string
  /** 云端项目的占位：服务端预留它的那个任务。 */
  readonly cloudGeneration?: { readonly id: string }
}

/**
 * 失败占位对应的原失败卡。重试记录不是出发点：重试失败之后占位仍指回原卡，
 * 云端项目里的占位则由重试任务接替，凭任务 id 找到的是重试记录，再顺着它回到原卡。
 */
export function agentRetryOrigin(
  messages: readonly AgentPanelMessage[],
  placeholder: AgentRetryPlaceholder,
): AgentToolMessage | null {
  const taskId = placeholder.cloudGeneration?.id
  const found = messages.find(
    (message): message is AgentToolMessage =>
      message.kind === 'tool' &&
      (placeholder.agentMessageId
        ? message.id === placeholder.agentMessageId
        : taskId !== undefined && message.job?.taskId === taskId),
  )
  if (!found?.retryOf) return found ?? null
  const origin = messages.find((message) => message.id === found.retryOf?.messageId)
  return origin?.kind === 'tool' ? origin : null
}

/** 快照里那个模型此刻还在这个部署的清单上（同一种介质）。下线了就交给智能体换个做法。 */
function modelOffered(message: AgentToolMessage): boolean {
  const model = message.snapshot?.target?.model
  const media = message.job?.media ?? 'image'
  return getStoredChannels().some((channel) =>
    channel.models.some((one) => one.id === model && (one.media ?? 'image') === media),
  )
}

/**
 * 这个失败占位此刻能不能原样重试。占位的码以它自己的为准：一次重试被拒（积分不够）之后，
 * 占位按新的码给出路，不再出重试。
 */
export function agentRetryAvailable(
  code: AgentToolErrorCode | undefined,
  origin: AgentToolMessage | null,
): origin is AgentToolMessage {
  return (
    code !== undefined &&
    AGENT_RETRYABLE_ERROR_CODES.includes(code) &&
    origin !== null &&
    agentToolRetryable(origin) &&
    modelOffered(origin)
  )
}

/** 预估积分的计价口径：一张图，或者按快照档位的那一段视频。与服务端预扣同一个算式。 */
export function agentRetryPricing(origin: AgentToolMessage): PrivateSubmissionInput {
  const model = origin.snapshot?.target?.model ?? ''
  const video = origin.job?.video
  if (origin.job?.media === 'video' && video)
    return {
      model,
      quantity: video.duration,
      unitMultiplier: videoRateMultiplier(model, video.resolution),
    }
  return { model, quantity: 1 }
}
