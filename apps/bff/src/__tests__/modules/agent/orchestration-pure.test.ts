import { describe, expect, it } from 'bun:test'
import { createMaskedEditPlan, MaskedOutputError } from '../../../modules/agent/contracts'
import {
  createSegmentRateLimiter,
  inwardMaskDistance,
  labelComponents,
  maskedEditSettings,
} from '../../../modules/agent/orchestration/masked/pure'

describe('modules/agent/orchestration/masked/pure (no-DB import safety)', () => {
  it('loads pure masked primitives and contracts without DATABASE_URL', () => {
    const err = new MaskedOutputError('mismatch')
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('mismatch')

    expect(maskedEditSettings.output.dimensionMultiple).toBe(16)

    const mask = new Uint8Array([0, 0, 0, 0, 1, 1, 0, 1, 1])
    const components = labelComponents(mask, 3, 3)
    expect(components.count).toBe(1)
    expect(components.areas[1]).toBe(4)

    const distance = inwardMaskDistance(mask, 3, 3)
    expect(distance.length).toBe(9)

    const limiter = createSegmentRateLimiter(2)
    const release = limiter.begin('user-1')
    expect(release).not.toBeNull()
    expect(limiter.begin('user-1')).toBeNull()
    release?.()

    const plan = createMaskedEditPlan(
      () => '',
      (id) => id,
    )
    expect(plan.protected).toBe(false)
    plan.protect()
    expect(plan.protected).toBe(true)
  })
})
