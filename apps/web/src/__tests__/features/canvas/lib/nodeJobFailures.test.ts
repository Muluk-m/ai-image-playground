import { describe, expect, it } from 'vitest'
import {
  noteNodeJobFailure,
  takeNodeJobFailure,
} from '../../../../features/canvas/lib/nodeJobFailures'
import { stageRejectionReason } from '../../../../features/canvas/lib/useAgentNodeRun'

describe('node job failure codes', () => {
  it('keeps the BFF code for the waiting batch and hands it out once', () => {
    noteNodeJobFailure(
      'job-1',
      Object.assign(new Error('x'), { submitErrorCode: 'stage_authorization_scope' }),
    )
    noteNodeJobFailure('job-2', new Error('upstream'))
    expect(takeNodeJobFailure('job-1')).toBe('stage_authorization_scope')
    expect(takeNodeJobFailure('job-1')).toBeUndefined()
    expect(takeNodeJobFailure('job-2')).toBeUndefined()
  })

  it('maps stage authorization codes to the reason reported to the agent', () => {
    expect(stageRejectionReason('stage_authorization_scope')).toBe('spec_changed')
    expect(stageRejectionReason('stage_authorization_budget')).toBe('budget_exceeded')
    expect(stageRejectionReason('stage_authorization_retry_limit')).toBe('retry_limit')
    expect(stageRejectionReason('stage_authorization_inactive')).toBe('authorization')
    expect(stageRejectionReason('quota_exceeded')).toBeUndefined()
    expect(stageRejectionReason(undefined)).toBeUndefined()
  })
})
