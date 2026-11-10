import { status } from 'elysia'
import { reservationFailureResponse } from './private-overlay'
import type { CreateQueueTaskOutcome } from './taskSubmission'

/** 提交没建出任务的那些结局。重复提交照样带回已有任务的 id。 */
export type SubmissionRefusal = Exclude<CreateQueueTaskOutcome, { kind: 'created' }>

/**
 * 网页提交接口被拒时的线上契约。单张与批量共用这一张表，别在各自路由里再写一遍；
 * CLI 有自己的错误信封，不走这里。
 */
export function submissionRefusalResponse(outcome: SubmissionRefusal) {
  switch (outcome.kind) {
    case 'invalid_prompt':
      return status(400, { error: 'invalid_request', message: '提示词不能为空' })
    case 'invalid_image_request':
      return status(400, { error: 'invalid_request', message: outcome.message })
    case 'model_unavailable':
      return status(400, { error: 'model_unavailable', message: outcome.message })
    case 'invalid_input_image':
      return status(400, { error: 'invalid_input_image', message: outcome.message })
    case 'idempotency_conflict':
    case 'idempotency_mismatch':
      return status(409, { error: 'idempotency_key_conflict' })
    case 'duplicate_submission':
      return status(409, { error: 'duplicate_submission', request_id: outcome.taskId })
    case 'object_storage_error':
      return status(503, { error: 'object_storage_error', message: outcome.message })
    case 'insufficient_credits':
    case 'price_unavailable':
      return reservationFailureResponse(outcome)
    case 'metering_denied':
      return status(403, { error: 'metering_denied', reason: outcome.reason })
    case 'authentication_required':
      return status(401, { error: 'unauthorized' })
    case 'private_billing_denied':
      return status(403, { error: 'plan_required', message: '4K 需要有效会员' })
    case 'quota_exceeded':
      return status(429, {
        error: 'daily_quota_exceeded',
        quota: outcome.quota.quota,
        used: outcome.quota.count,
        reset_at: outcome.quota.reset_at,
      })
    case 'max_credits_exceeded':
      return status(402, {
        error: 'max_credits_exceeded',
        required: outcome.required,
        max_credits: outcome.maxCredits,
      })
    default: {
      const unhandled: never = outcome
      throw new Error(`unhandled submission refusal ${JSON.stringify(unhandled)}`)
    }
  }
}
