import {
  _setPrivateBffOverlayForTesting,
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
    answer: { kind: 'reserved' },
    reset() {
      recorded.reservations.length = 0
      recorded.settlements.length = 0
      recorded.answer = { kind: 'reserved' }
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
        },
      },
    }),
  )
  return recorded
}
