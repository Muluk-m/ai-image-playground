import { agentImageCount } from './tools/queueParams'

export interface MaskedOperation {
  readonly targetImageId: string
  readonly selectionId?: string
  readonly requestQuote: string
  readonly n?: number
}

interface PlanCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

const key = (operation: MaskedOperation) =>
  JSON.stringify([
    operation.targetImageId,
    operation.selectionId ?? '',
    operation.requestQuote,
    agentImageCount(operation),
  ])

/** 首次付费前固定操作与数量；依赖产物的后续操作也必须提前列明。 */
export function createMaskedEditPlan(
  instructions: () => string,
  identify: (id: string) => string,
  initiallyProtected = false,
) {
  let locked = false
  let protectedTurn = initiallyProtected
  let calls = new Set<string>()
  let deferred = new Set<string>()
  return {
    get protected() {
      return protectedTurn
    },
    protect() {
      protectedTurn = true
    },
    capture(batch: readonly PlanCall[]) {
      if (locked) return
      calls = new Set(
        batch
          .filter((call) => ['editImage', 'generateImage'].includes(call.name))
          .map((call) => call.id),
      )
      deferred = new Set()
      for (const call of batch) {
        if (call.name !== 'editImage' || !Array.isArray(call.arguments.deferredEdits)) continue
        for (const value of call.arguments.deferredEdits.slice(0, 8)) {
          if (!value || typeof value !== 'object') continue
          const op = value as Partial<MaskedOperation>
          if (
            typeof op.targetImageId !== 'string' ||
            typeof op.requestQuote !== 'string' ||
            !op.requestQuote.trim() ||
            !instructions().includes(op.requestQuote)
          )
            continue
          if (op.selectionId !== undefined && typeof op.selectionId !== 'string') continue
          if (
            op.n !== undefined &&
            (!Number.isInteger(op.n) || op.n < 1 || op.n !== agentImageCount(op))
          )
            continue
          deferred.add(
            key({
              ...op,
              targetImageId: identify(op.targetImageId),
              requestQuote: op.requestQuote,
            }),
          )
        }
      }
    },
    includes(id: string, operation?: MaskedOperation) {
      return calls.has(id) || Boolean(locked && operation && deferred.has(key(operation)))
    },
    submitted(id: string, operation?: MaskedOperation) {
      locked = true
      calls.delete(id)
      if (operation) deferred.delete(key(operation))
    },
    interjected() {
      // 状态询问和普通插话不解锁新的付费预算。
      if (!locked) {
        calls.clear()
        deferred.clear()
      }
    },
  }
}
