import { db } from '../../db/client'
import type {
  AccountLifecyclePort,
  BillingPorts,
  EntitlementPort,
  MeteringPort,
  PrivateTaskHooks,
} from '../../lib/billing-hooks'
import { isCapabilityEnabled } from '../../lib/capabilities'
import {
  accountConcurrencyEntitlement,
  accountConcurrencyLimit,
  canSubmitTask,
  canUnlinkOAuthIdentity,
  consumeUnmeteredQuota,
  hasActiveSubscription,
  isActiveMember,
  meteringDecision,
  scanDueAccounts,
} from './entitlement'
import { finalizeTask, onUserCreated, reserveTask, taskCredits } from './ledger'
import { notifyNewOrders } from './order-notifications'
import { getChatPricing, quoteTask, quoteTokenTask } from './pricing'
import { getAccountSnapshot } from './queries'

export const billingMeteringPort: MeteringPort = Object.freeze({
  meteringDecision,
  consumeUnmeteredQuota,
  quoteTask,
  quoteTokenTask,
  chatPricing: getChatPricing,
  reserveTask,
  finalizeTask,
  taskCredits,
})

export const billingEntitlementPort: EntitlementPort = Object.freeze({
  canSubmitTask,
  isActiveMember,
  async accountSummary({ userId, now }) {
    if (!isCapabilityEnabled('billing:credits')) return null
    const snapshot = await getAccountSnapshot(userId, now)
    return {
      credits: snapshot.account
        ? snapshot.account.subscription_balance + snapshot.account.recharge_balance
        : 0,
      isMember: await hasActiveSubscription(db, userId, now),
      unmetered: snapshot.unmetered?.enabled === true,
    }
  },
  accountConcurrencyLimit,
  accountConcurrencyEntitlement,
})

export const billingAccountLifecyclePort: AccountLifecyclePort = Object.freeze({
  onUserCreated,
  canUnlinkOAuthIdentity,
  async runMaintenance(now) {
    if (!isCapabilityEnabled('billing:credits')) return
    await scanDueAccounts(now)
  },
  async runWorkerMaintenance(now) {
    if (!isCapabilityEnabled('billing:credits')) return
    await notifyNewOrders(now)
  },
})

export const billingPorts: BillingPorts = Object.freeze({
  metering: billingMeteringPort,
  entitlement: billingEntitlementPort,
  accountLifecycle: billingAccountLifecyclePort,
})

export const privateTaskHooks: PrivateTaskHooks = Object.freeze({
  ...billingMeteringPort,
  ...billingEntitlementPort,
  ...billingAccountLifecyclePort,
})
