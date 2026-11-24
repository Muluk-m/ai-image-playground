import {
  agentImageCount,
  type MaskedApproval,
  type MaskedEditContent,
  type MaskedEditPlan,
  type MaskedOperation,
  type MaskedPlanCarry,
  type MaskedSubmission,
  mergeMaskedPlanCarries,
  type PlanCall,
} from '../../modules/agent/contracts'

export {
  type MaskedApproval,
  type MaskedEditContent,
  type MaskedEditPlan,
  type MaskedOperation,
  type MaskedPlanCarry,
  type MaskedSubmission,
  mergeMaskedPlanCarries,
  type PlanCall,
}

const key = (operation: MaskedOperation) =>
  JSON.stringify([
    operation.targetImageId,
    operation.selectionId ?? '',
    operation.requestQuote,
    agentImageCount(operation),
  ])

const contentKey = (content: MaskedEditContent) =>
  JSON.stringify([
    content.imageIds,
    content.selectionBindings?.map(({ imageId, selectionId }) => [imageId, selectionId]).sort(),
    content.quote,
  ])

/**
 * 首次付费前固定操作与数量；依赖产物的后续操作也必须提前列明。唤醒轮带着 `carried` 起：
 * 批次早已冻结，只能执行剩下的后续编辑，提交过的内容仍算提交过。
 */
export function createMaskedEditPlan(
  authorizationText: () => string,
  identify: (id: string) => string,
  initiallyProtected = false,
  carried?: MaskedPlanCarry,
): MaskedEditPlan {
  let locked = carried !== undefined
  let protectedTurn = initiallyProtected || Boolean(carried?.protected)
  let calls = new Set<string>()
  let deferred = new Set<string>(carried?.deferred)
  const contents = new Set<string>(carried?.contents)
  const inBatch = (toolCallId: string, operation?: MaskedOperation) =>
    calls.has(toolCallId) || Boolean(locked && operation && deferred.has(key(operation)))
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
            !authorizationText().includes(op.requestQuote)
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
    approve(submission: MaskedSubmission) {
      // 内容先问：一条既重复又在批次外的调用，该听的是「这条提过了」。
      if (submission.content && contents.has(contentKey(submission.content)))
        return 'already-submitted'
      if (submission.call && !inBatch(submission.call.toolCallId, submission.call.operation))
        return 'outside-batch'
      return 'approved'
    },
    submitted(submission: MaskedSubmission) {
      if (submission.content) contents.add(contentKey(submission.content))
      if (!submission.call) return
      locked = true
      calls.delete(submission.call.toolCallId)
      if (submission.call.operation) deferred.delete(key(submission.call.operation))
    },
    interjected() {
      // 状态询问和普通插话不解锁新的付费预算。已经提交过的内容照旧算提交过。
      if (!locked) {
        calls.clear()
        deferred.clear()
      }
    },
    carryAfter(submission: MaskedSubmission) {
      const done = submission.call?.operation && key(submission.call.operation)
      return {
        authorization: authorizationText(),
        protected: protectedTurn,
        contents: [
          ...new Set([
            ...contents,
            ...(submission.content ? [contentKey(submission.content)] : []),
          ]),
        ],
        deferred: [...deferred].filter((operation) => operation !== done),
      }
    },
  }
}
