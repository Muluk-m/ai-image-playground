import { afterEach, describe, expect, it } from 'bun:test'
import {
  loadAccountLifecyclePort,
  loadBillingPorts,
  loadEntitlementPort,
  loadMeteringPort,
} from '../../lib/billing-ports'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
  type PrivateTaskHooks,
} from '../../lib/private-overlay'

afterEach(() => {
  _setPrivateBffOverlayForTesting()
})

describe('narrow billing ports', () => {
  it('partitions PrivateTaskHooks into 3 disjoint narrow ports without leaking unrelated methods', async () => {
    const fullHooks: PrivateTaskHooks = {
      ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
      async meteringDecision() {
        return { kind: 'metered', metering: 'credits' }
      },
      async consumeUnmeteredQuota() {
        return { kind: 'consumed' }
      },
      async quoteTask() {
        return null
      },
      async quoteTokenTask() {
        return null
      },
      async isActiveMember() {
        return true
      },
      async accountSummary() {
        return null
      },
      async accountConcurrencyLimit() {
        return 2
      },
      async accountConcurrencyEntitlement() {
        return { guaranteed: 2, idle: 3 }
      },
      async canUnlinkOAuthIdentity() {
        return { allowed: true }
      },
      async onUserDeleted() {},
      async runWorkerMaintenance() {},
    }
    _setPrivateBffOverlayForTesting({
      ...EMPTY_PRIVATE_BFF_OVERLAY,
      present: true,
      taskHooks: fullHooks,
    })

    const [metering, entitlement, lifecycle] = await Promise.all([
      loadMeteringPort(),
      loadEntitlementPort(),
      loadAccountLifecyclePort(),
    ])

    expect(Object.keys(metering).sort()).toEqual([
      'chatPricing',
      'consumeUnmeteredQuota',
      'finalizeTask',
      'meteringDecision',
      'quoteTask',
      'quoteTokenTask',
      'reserveTask',
      'taskCredits',
    ])
    expect(Object.keys(entitlement).sort()).toEqual([
      'accountConcurrencyEntitlement',
      'accountConcurrencyLimit',
      'accountSummary',
      'canSubmitTask',
      'isActiveMember',
    ])
    expect(Object.keys(lifecycle).sort()).toEqual([
      'canUnlinkOAuthIdentity',
      'onUserCreated',
      'onUserDeleted',
      'runMaintenance',
      'runWorkerMaintenance',
    ])
  })

  it('preserves undefined optional methods and updates immediately when overlay taskHooks are replaced', async () => {
    const minimalHooks: PrivateTaskHooks = {
      async reserveTask() {
        return { kind: 'reserved', credits: 1 }
      },
      async finalizeTask() {},
      async chatPricing() {
        return null
      },
      async taskCredits() {
        return {}
      },
      async onUserCreated() {},
      async runMaintenance() {},
    }
    _setPrivateBffOverlayForTesting({
      ...EMPTY_PRIVATE_BFF_OVERLAY,
      present: true,
      taskHooks: minimalHooks,
    })

    const first = await loadBillingPorts()
    expect(first.entitlement.canSubmitTask).toBeUndefined()
    expect(first.metering.meteringDecision).toBeUndefined()
    expect(first.metering.consumeUnmeteredQuota).toBeUndefined()
    expect(first.accountLifecycle.onUserDeleted).toBeUndefined()

    // Spreading a previous overlay while overriding taskHooks must project the new functions.
    const secondQuote = async () => null
    _setPrivateBffOverlayForTesting({
      ...EMPTY_PRIVATE_BFF_OVERLAY,
      present: true,
      taskHooks: {
        ...minimalHooks,
        quoteTask: secondQuote,
      },
    })

    const second = await loadBillingPorts()
    expect(second).not.toBe(first)
    expect(second.metering.quoteTask).toBe(secondQuote)
  })
})
