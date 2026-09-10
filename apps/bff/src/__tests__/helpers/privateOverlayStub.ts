import { FALLBACK_CHAT_PRICING } from '../../lib/agent/billing'
import {
  _setPrivateBffOverlayForTesting,
  type ChatPricing,
  EMPTY_PRIVATE_BFF_OVERLAY,
  type PrivateTaskHooks,
  type TaskReservationResult,
} from '../../lib/private-overlay'

export type RecordedReservation = Omit<Parameters<PrivateTaskHooks['reserveTask']>[0], 'tx'>
export type RecordedSettlement = Omit<Parameters<PrivateTaskHooks['finalizeTask']>[0], 'tx'>

export interface RecordedTaskHooks {
  readonly reservations: RecordedReservation[]
  readonly settlements: RecordedSettlement[]
  /** 下一次预扣的答复；测余额不足与缺单价时改它。 */
  answer: TaskReservationResult
  /** 单价表交给公开树的对话定价；null 走公开树的兜底。 */
  pricing: ChatPricing | null
  /** 结算报回的扣费额；退回的终态照真账本报 0。 */
  settledCredits: number
  /** `taskCredits` 对任意任务的答复；工具提交的任务 id 测试事先不知道。 */
  creditsPerTask: number
  reset(): void
}

/**
 * `billing:credits` 要求 overlay 在场，所以这个替身必须在被测路由求值前装好——
 * 在模块顶层调用，不要放进 `beforeEach`。
 */
export function installRecordingTaskHooks(): RecordedTaskHooks {
  const recorded: RecordedTaskHooks = {
    reservations: [],
    settlements: [],
    answer: { kind: 'reserved', credits: 0 },
    pricing: FALLBACK_CHAT_PRICING,
    settledCredits: 0,
    creditsPerTask: 0,
    reset() {
      recorded.reservations.length = 0
      recorded.settlements.length = 0
      recorded.answer = { kind: 'reserved', credits: 0 }
      recorded.pricing = FALLBACK_CHAT_PRICING
      recorded.settledCredits = 0
      recorded.creditsPerTask = 0
    },
  }
  _setPrivateBffOverlayForTesting(
    Object.freeze({
      ...EMPTY_PRIVATE_BFF_OVERLAY,
      present: true,
      taskHooks: {
        ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
        async reserveTask({ tx: _tx, ...rest }: Parameters<PrivateTaskHooks['reserveTask']>[0]) {
          recorded.reservations.push(rest)
          return recorded.answer
        },
        async finalizeTask({ tx: _tx, ...rest }: Parameters<PrivateTaskHooks['finalizeTask']>[0]) {
          recorded.settlements.push(rest)
          return { credits: rest.outcome === 'completed' ? recorded.settledCredits : 0 }
        },
        async taskCredits({ taskIds }: Parameters<PrivateTaskHooks['taskCredits']>[0]) {
          return Object.fromEntries(taskIds.map((id) => [id, recorded.creditsPerTask]))
        },
        async chatPricing() {
          return recorded.pricing
        },
      },
    }),
  )
  return recorded
}
