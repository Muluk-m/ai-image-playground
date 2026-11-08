import { describe, expect, it } from 'bun:test'
import type { TaskErrorType } from '@image-playground/shared'
import { taskFailureLogLevel } from '../../lib/task-failure-log'

describe('task failure log level', () => {
  it('keeps a rejected prompt out of the error count', () => {
    expect(taskFailureLogLevel('content_policy')).toBe('warn')
  })

  it('keeps every other failure as an error for operators, plan_required included', () => {
    // plan_required reaching a worker means direct routes are down or unconfigured: ours to fix.
    const operational: TaskErrorType[] = [
      'plan_required',
      'upstream_timeout',
      'upstream_result_unknown',
      'upstream_error',
      'model_unavailable',
      'rate_limited',
      'upstream_no_image',
      'interrupted',
      'object_storage_error',
      'unknown',
    ]
    for (const errorType of operational) expect(taskFailureLogLevel(errorType)).toBe('error')
  })
})
