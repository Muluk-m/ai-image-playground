// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  groupHasUnseenFeature,
  isFeatureUnseen,
  isFeatureWithinWindow,
  markFeatureSeen,
  readSeenFeatures,
  resetSeenFeatures,
  SEEN_FEATURES_KEY,
} from '../../lib/featureDiscovery'

function createStorageShim() {
  const map = new Map<string, string>()
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    removeItem: (key: string) => {
      map.delete(key)
    },
    clear: () => map.clear(),
  }
}

describe('featureDiscovery', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createStorageShim())
    resetSeenFeatures()
  })

  afterEach(() => {
    resetSeenFeatures()
    vi.unstubAllGlobals()
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

    expect(localStorage.getItem(SEEN_FEATURES_KEY)).toContain('composer.batchMode')
    expect(readSeenFeatures().has('composer.batchMode')).toBe(true)
    expect(isFeatureUnseen('composer.batchMode', readSeenFeatures(), now)).toBe(false)
    expect(groupHasUnseenFeature('composer-mode', readSeenFeatures(), now)).toBe(false)
  })
})
