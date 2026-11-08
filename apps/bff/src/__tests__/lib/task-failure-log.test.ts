import { describe, expect, it } from 'bun:test'
import type { TaskErrorType } from '@image-playground/shared'
import { taskFailureLogLevel } from '../../lib/task-failure-log'

describe('task failure log level', () => {
  it('keeps failures that are the user request itself out of the error count', () => {
    expect(taskFailureLogLevel('content_policy')).toBe('warn')
    expect(taskFailureLogLevel('plan_required')).toBe('warn')
  })

  it('keeps every other failure as an error for operators', () => {
    const operational: TaskErrorType[] = [
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
