import { describe, expect, it } from 'vitest'
import {
  noteNodeJobFailure,
  takeNodeJobFailure,
} from '../../../../features/canvas/lib/nodeJobFailures'

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

})
