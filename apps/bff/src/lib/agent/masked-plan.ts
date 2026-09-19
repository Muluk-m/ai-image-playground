import { agentImageCount } from './tools/queueParams'

export interface MaskedOperation {
  readonly targetImageId: string
  readonly selectionId?: string
  readonly requestQuote: string
  readonly n?: number
}

/** 一次真遮罩编辑做的是哪件事：换个 tool-call id 重来一次，批次身份认不出，内容身份认得出。 */
export interface MaskedEditContent {
  readonly imageIds: readonly string[]
  readonly selectionBindings?: readonly { readonly imageId: string; readonly selectionId: string }[]
  /** 这次操作对应的用户原文；模型没摘录时回落到工具起跑时的整段授权原文。 */
  readonly quote?: string
}

/** 要提交的这次付费操作。两个身份各自回答一个问题，缺席即那个问题不适用。 */
export interface MaskedSubmission {
  /** 本轮遮罩批次里的这次调用；缺席即这次提交不受批次约束（非遮罩轮）。 */
  readonly call?: {
    readonly toolCallId: string
    readonly operation?: MaskedOperation
  }
  /** 这次编辑的内容身份；缺席即它不是真遮罩编辑（生图、无遮罩改图）。 */
  readonly content?: MaskedEditContent
}

/** 为什么不能提交。放行之外的每一个取值对应模型该做的一件不同的事，所以不是布尔。 */
export type MaskedApproval =
  /** 可以提交。 */
  | 'approved'
  /** 这条内容本轮已经提交过，模型该去看候选而不是再付一次费。 */
  | 'already-submitted'
  /** 不在冻结的批次里，模型该停下等用户指示而不是自行追加。 */
  | 'outside-batch'

/** 助手消息里的一次工具调用，批次照它冻结。 */
export interface PlanCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

/**
 * 计划交给唤醒轮的那一份：提交那一刻的授权原文与计划状态。唤醒轮不是用户开的，它的计划不另起，
 * 而是接着提交那一轮的走——已经付过费的内容照样不能重提，遮罩轮只剩预先列明、还没执行的后续编辑。
 */
export interface MaskedPlanCarry {
  /** 提交那一刻的授权原文；唤醒轮按它核对 requestQuote，连续几次唤醒也还是用户最初的原话。 */
  readonly authorization: string
  readonly protected: boolean
  /** 已经提交过的真遮罩编辑的内容身份。 */
  readonly contents: readonly string[]
  /** 预先列明、还没执行的后续编辑。 */
  readonly deferred: readonly string[]
}

export interface MaskedEditPlan {
  /** 本轮是不是已经进入遮罩作用域；进入后不因引用被换掉而解除。 */
  readonly protected: boolean
  protect(): void
  /** 首条带工具调用的助手消息处冻结批次；提交过任务后不再重冻。 */
  capture(batch: readonly PlanCall[]): void
  /** 「这次付费操作能不能提交」的唯一回答者。 */
  approve(submission: MaskedSubmission): MaskedApproval
  /** 任务真的建出来了才登记；失败的提交不占批次名额，也不算内容提交过。 */
  submitted(submission: MaskedSubmission): void
  interjected(): void
  /** 这次提交登记之后计划会是什么样：随任务一起记下，唤醒轮据此接着执行。 */
  carryAfter(submission: MaskedSubmission): MaskedPlanCarry
}

/** 同一批里几个任务各自记下的计划合成一份：内容取并集，后续编辑以最后提交的那一次为准。 */
export function mergeMaskedPlanCarries(
  carries: readonly MaskedPlanCarry[],
): MaskedPlanCarry | undefined {
  const last = carries.at(-1)
  if (!last) return undefined
  return {
    authorization: last.authorization,
    protected: carries.some((carry) => carry.protected),
    contents: [...new Set(carries.flatMap((carry) => carry.contents))],
    deferred: last.deferred,
  }
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
