// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import {
  groupHasUnseenFeature,
  isFeatureUnseen,
  isFeatureWithinWindow,
  markFeatureSeen,
  readSeenFeatures,
  SEEN_FEATURES_KEY,
} from '../../lib/featureDiscovery'

describe('featureDiscovery', () => {
  beforeEach(() => {
    localStorage.removeItem(SEEN_FEATURES_KEY)
  })

  it('respects launch expiry window', () => {
    const inside = new Date(2026, 10, 24).getTime()
    const expired = new Date(2027, 0, 2).getTime()
    expect(isFeatureWithinWindow('composer.batchMode', inside)).toBe(true)
    expect(isFeatureWithinWindow('composer.batchMode', expired)).toBe(false)
    expect(isFeatureUnseen('composer.batchMode', new Set(), expired)).toBe(false)
  })

  it('lights the group dot until all active features in the group are marked seen', () => {
    const now = new Date(2026, 10, 24).getTime()
    expect(groupHasUnseenFeature('composer-mode', readSeenFeatures(), now)).toBe(true)
    expect(isFeatureUnseen('composer.batchMode', readSeenFeatures(), now)).toBe(true)

    markFeatureSeen('composer.batchMode')

    expect(readSeenFeatures().has('composer.batchMode')).toBe(true)
    expect(isFeatureUnseen('composer.batchMode', readSeenFeatures(), now)).toBe(false)
    expect(groupHasUnseenFeature('composer-mode', readSeenFeatures(), now)).toBe(false)
  })
})
