import { expect, it } from 'bun:test'
import { type SubmissionRefusal, submissionRefusalResponse } from '../../lib/submissionRefusal'

const quota = { ok: false, count: 20, quota: 20, reset_at: '2026-11-09T00:00:00.000Z' }

// 单张提交与批量提交共用这张表，每种拒绝结局一行。
const table: ReadonlyArray<readonly [SubmissionRefusal, number, Record<string, unknown>]> = [
  [{ kind: 'invalid_prompt' }, 400, { error: 'invalid_request' }],
  [
    { kind: 'invalid_image_request', message: 'bad size' },
    400,
    { error: 'invalid_request', message: 'bad size' },
  ],
  [{ kind: 'invalid_input_image', message: 'bad ref' }, 400, { error: 'invalid_input_image' }],
  [{ kind: 'idempotency_conflict' }, 409, { error: 'idempotency_key_conflict' }],
  [{ kind: 'idempotency_mismatch' }, 409, { error: 'idempotency_key_conflict' }],
  [
    { kind: 'duplicate_submission', taskId: 't1' },
    409,
    { error: 'duplicate_submission', request_id: 't1' },
  ],
  [{ kind: 'object_storage_error', message: 'down' }, 503, { error: 'object_storage_error' }],
  [
    { kind: 'insufficient_credits', required: 30, available: 10 },
    402,
    { error: 'insufficient_credits', required: 30, available: 10 },
  ],
  [
    { kind: 'price_unavailable', model: 'm' },
    422,
    { error: 'model_price_unavailable', model: 'm' },
  ],
  // 批量接口以前把这一种兜底成 401，前端会当成掉登录。
  [
    { kind: 'metering_denied', reason: 'blocked' },
    403,
    { error: 'metering_denied', reason: 'blocked' },
  ],
  [{ kind: 'authentication_required' }, 401, { error: 'unauthorized' }],
  [{ kind: 'private_billing_denied' }, 403, { error: 'plan_required' }],
  [
    { kind: 'quota_exceeded', quota },
    429,
    { error: 'daily_quota_exceeded', quota: 20, used: 20, reset_at: quota.reset_at },
  ],
  [
    { kind: 'max_credits_exceeded', required: 40, maxCredits: 20 },
    402,
    { error: 'max_credits_exceeded', required: 40, max_credits: 20 },
  ],
]

it.each(table)('%o → %i', (outcome, code, body) => {
  const response = submissionRefusalResponse(outcome)
  expect(response.code).toBe(code)
  expect(response.response).toMatchObject(body)
})
