import type { AgentToolErrorCode } from '@image-playground/shared'
import { AGENT_RETRYABLE_ERROR_CODES } from '@image-playground/shared'
import { promptLogin } from '../../../auth/loginPrompt'
import { i18next } from '../../../i18n'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { notifyPrivateSubmissionError, PrivateWebOverlayPresent } from '../../../lib/privateOverlay'
import type { AgentRerunBlock } from './retry'

/**
 * 一次失败的工具调用给用户的出路。界面只按错误码决定（ADR 0006），不读服务端的 `message`。
 * 上游出错、超时、没出图的出路是重试，那是另一张票的事；这里对它们不给按钮——除非调用方
 * 说得出这次为什么重出不了（`AgentRerunBlock`），那时改由智能体换个做法。
 * 按钮必须真能解决问题：这个部署没有充值入口、没有登录时，只留原因不给按钮。
 */
export type AgentToolFailureAction = 'recharge' | 'login' | 'reprocess'

/** 充值入口在收费 overlay 里，且只在开了积分计费的部署上存在。 */
function canRecharge(): boolean {
  return PrivateWebOverlayPresent && isClientCapabilityEnabled('billing:credits')
}

/**
 * 钱不够导致的失败当场把开通/充值面板叫出来。
 *
 * 失败卡片上本来就有「去充值」，但那要用户先看见那张卡、再看懂那句话、再去点。
 * 余额见底不是这一次生成的问题，是账户的问题：不当场说清，用户只会当成又一次
 * 生成失败，接着一遍遍重试，每次都失败。没有计费 overlay 的部署里这是空操作。
 */
export function promptAgentRecharge(code: AgentToolErrorCode | undefined): void {
  if (code === 'insufficient_credits' || code === 'quota_exceeded')
    notifyPrivateSubmissionError({ insufficientCredits: true })
}

export function agentToolFailureAction(
  code: AgentToolErrorCode | undefined,
  /**
   * 这次跑过的生成为什么重出不了；`null` 即重出得了，或者压根认不出这是哪一次生成。
   * 缺席等同 `null`：调用方不关心重试时按码原样分流。
   */
  block: AgentRerunBlock | null = null,
): AgentToolFailureAction | null {
  switch (code) {
    case 'insufficient_credits':
    // 额度只在不计积分的部署上用（每日设备额度），那里通常没有充值入口，交给 `canRecharge` 判。
    case 'quota_exceeded':
      return canRecharge() ? 'recharge' : null
    case 'authentication_required':
      return isClientCapabilityEnabled('accounts:login') ? 'login' : null
    case 'invalid_params':
    // 原样重试稳定复现，唯一的出路是改写提示词——那正是「让助手重新处理」要做的事。
    case 'content_policy':
    case 'model_unavailable':
      return 'reprocess'
    default:
      // 可重试的那几个码正常由重试按钮收场。重出不了时它们就一个出路都没有了，交给智能体
      // 换个做法。其余的码（取消、结果未知、没有码）不适用。
      return block !== null && code !== undefined && AGENT_RETRYABLE_ERROR_CODES.includes(code)
        ? 'reprocess'
        : null
  }
}

/** 失败原因的一句话，按错误码取译文。没有码（旧记录）时返回 null，调用方照旧处理。 */
export function agentToolFailureText(code: AgentToolErrorCode | undefined): string | null {
  const t = i18next.getFixedT(null, 'errors')
  switch (code) {
    case undefined:
      return null
    case 'upstream_error':
      return t('agentTool.upstream_error')
    case 'timeout':
      return t('agentTool.timeout')
    case 'no_output':
      return t('agentTool.no_output')
    case 'result_unknown':
      return t('agentTool.result_unknown')
    case 'insufficient_credits':
      return t('agentTool.insufficient_credits')
    case 'quota_exceeded':
      return t('agentTool.quota_exceeded')
    case 'authentication_required':
      return t('agentTool.authentication_required')
    case 'invalid_params':
      return t('agentTool.invalid_params')
    case 'content_policy':
      return t('agentTool.content_policy')
    case 'model_unavailable':
      return t('agentTool.model_unavailable')
    case 'cancelled':
      return t('agentTool.cancelled')
    default:
      return t('agentTool.fallback')
  }
}

export function agentToolFailureActionLabel(
  action: AgentToolFailureAction,
  code?: AgentToolErrorCode,
): string {
  const t = i18next.getFixedT(null, 'agent')
  if (action === 'recharge') return t('toolFailure.recharge')
  if (action === 'login') return t('toolFailure.login')
  // 内容安全拒绝只有改写这一条路，按钮直说要它做什么，别让用户猜「重新处理」是什么。
  if (code === 'content_policy') return t('toolFailure.rewrite')
  return t('toolFailure.reprocess')
}

/**
 * 「让助手重新处理」替用户说的那句话。它是用户消息，按此刻的界面语言写，写完不再翻译。
 * 把失败的那次调用与原因说清，智能体就能换个做法，而不是原样再来一遍。
 *
 * 重出不了的那两种失败，理由**不能**只写错误码的译文：一次瞬时的「生成服务出错了」，
 * 最自然的做法恰恰是原样再调一次，那正是这条出路要避免的。所以理由改写成真正的阻碍。
 */
export function agentReprocessMessage(
  title: string,
  code: AgentToolErrorCode,
  block: AgentRerunBlock | null = null,
): string {
  const reason = block
    ? i18next.t(`toolFailure.blocked.${block}`, { ns: 'agent' })
    : (agentToolFailureText(code) ?? '')
  // 内容安全拒绝要的是改词，不是换做法：说成「换个做法」会让智能体去换模型或换参数。
  if (code === 'content_policy')
    return i18next.t('toolFailure.rewriteMessage', { ns: 'agent', title, reason })
  return i18next.t('toolFailure.reprocessMessage', { ns: 'agent', title, reason })
}

export interface AgentToolFailureContext {
  readonly code: AgentToolErrorCode
  /** 失败的那次调用在面板上的标签，说明性消息里用它指认。 */
  readonly title: string
  /** 这次生成为什么重出不了；缺席即出路不是由「重出不了」引出的，理由照旧取错误码译文。 */
  readonly block?: AgentRerunBlock | null
  /** 替用户发消息的出口；由调用方接到智能体面板的发送上。 */
  readonly send: (text: string) => void
}

export function runAgentToolFailureAction(
  action: AgentToolFailureAction,
  context: AgentToolFailureContext,
): void {
  if (action === 'recharge') {
    // 收费形态的 overlay 认这个信号并打开充值面板；免费形态没有计费，这里什么也不发生。
    notifyPrivateSubmissionError({ insufficientCredits: true })
    return
  }
  if (action === 'login') {
    // 未登录访客照常留在工作台，只把登录框叫起来；整页跳登录会把他手上这段对话连同画布一起冲掉。
    promptLogin('gated-action')
    return
  }
  context.send(agentReprocessMessage(context.title, context.code, context.block ?? null))
}
