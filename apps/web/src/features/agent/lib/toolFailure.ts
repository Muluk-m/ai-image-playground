import type { AgentToolErrorCode } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { AUTH_SESSION_EXPIRED_EVENT } from '../../../lib/authClient'
import { isClientCapabilityEnabled } from '../../../lib/clientCapabilities'
import { notifyPrivateSubmissionError, PrivateWebOverlayPresent } from '../../../lib/privateOverlay'

/**
 * 一次失败的工具调用给用户的出路。界面只按错误码决定（ADR 0006），不读服务端的 `message`。
 * 上游出错、超时、没出图的出路是重试，那是另一张票的事；这里对它们不给按钮。
 * 按钮必须真能解决问题：这个部署没有充值入口、没有登录时，只留原因不给按钮。
 */
export type AgentToolFailureAction = 'recharge' | 'login' | 'reprocess'

/** 充值入口在收费 overlay 里，且只在开了积分计费的部署上存在。 */
function canRecharge(): boolean {
  return PrivateWebOverlayPresent && isClientCapabilityEnabled('billing:credits')
}

export function agentToolFailureAction(
  code: AgentToolErrorCode | undefined,
): AgentToolFailureAction | null {
  switch (code) {
    case 'insufficient_credits':
    // 额度只在不计积分的部署上用（每日设备额度），那里通常没有充值入口，交给 `canRecharge` 判。
    case 'quota_exceeded':
      return canRecharge() ? 'recharge' : null
    case 'authentication_required':
      return isClientCapabilityEnabled('accounts:login') ? 'login' : null
    case 'invalid_params':
    case 'model_unavailable':
      return 'reprocess'
    default:
      return null
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
    case 'model_unavailable':
      return t('agentTool.model_unavailable')
    case 'cancelled':
      return t('agentTool.cancelled')
    default:
      return t('agentTool.fallback')
  }
}

export function agentToolFailureActionLabel(action: AgentToolFailureAction): string {
  const t = i18next.getFixedT(null, 'agent')
  if (action === 'recharge') return t('toolFailure.recharge')
  if (action === 'login') return t('toolFailure.login')
  return t('toolFailure.reprocess')
}

/**
 * 「让助手重新处理」替用户说的那句话。它是用户消息，按此刻的界面语言写，写完不再翻译。
 * 把失败的那次调用与原因说清，智能体就能换个做法，而不是原样再来一遍。
 */
export function agentReprocessMessage(title: string, code: AgentToolErrorCode): string {
  return i18next.t('toolFailure.reprocessMessage', {
    ns: 'agent',
    title,
    reason: agentToolFailureText(code) ?? '',
  })
}

export interface AgentToolFailureContext {
  readonly code: AgentToolErrorCode
  /** 失败的那次调用在面板上的标签，说明性消息里用它指认。 */
  readonly title: string
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
    window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT))
    return
  }
  context.send(agentReprocessMessage(context.title, context.code))
}
