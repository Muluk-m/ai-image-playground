// @vitest-environment jsdom

import type { PurchaseOrder } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContextProvider } from '../../auth/AuthContext'
import SyncStatusPanel from '../../components/SyncStatusPanel'
import {
  clearPendingBillingModal,
  clearPricingLaunchPeriod,
  clearRechargeLaunchAmount,
  consumePendingBillingModal,
  peekPricingLaunchPeriod,
  peekRechargeLaunchAmount,
  queueBillingModal,
} from '../../features/billing/billing-store'
import { PaymentSurface } from '../../features/billing/PaymentPanel'
import { useSyncStatus } from '../../lib/sync/status'

vi.mock('../../lib/sync/engine', () => ({ syncNow: vi.fn() }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const BASE_ORDER: PurchaseOrder = {
  id: 'order-b5',
  code: 'XYZ789',
  user_id: 'user-1',
  plan_id: 'standard',
  plan_name: '标准',
  period_months: 1,
  amount_cents: 7900,
  status: 'pending',
  created_at: 0,
  expires_at: Date.now() + 600_000,
  claimed_at: null,
  completed_at: null,
  ends_at: null,
  review_note: '',
  payment_code: { id: 'qr1', channel: 'wechat', account: 'account', url: '/pay.png' },
  payment_history: [],
  payment_available: true,
  contact_qr_url: '/contact.png',
  contact_wechat: 'support',
  notification_status: 'pending',
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  sessionStorage.clear()
  clearPendingBillingModal()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useSyncStatus.setState({
    enabled: false,
    status: 'idle',
    pending: 0,
    lastSyncedAt: null,
    uploads: null,
    failure: null,
  })
})

describe('Batch 5 Billing, Auth & Sync UX polish', () => {
  it('preserves selected billing period and recharge amount across queued modal handoff', () => {
    queueBillingModal('pricing', { period: 12 })
    expect(consumePendingBillingModal()).toBe('pricing')
    expect(peekPricingLaunchPeriod()).toBe(12)
    expect(peekPricingLaunchPeriod()).toBe(12)
    clearPricingLaunchPeriod()
    expect(peekPricingLaunchPeriod()).toBeUndefined()

    queueBillingModal('recharge', { amountYuan: 100 })
    expect(consumePendingBillingModal()).toBe('recharge')
    expect(peekRechargeLaunchAmount()).toBe(100)
    expect(peekRechargeLaunchAmount()).toBe(100)
    clearRechargeLaunchAmount()
    expect(peekRechargeLaunchAmount()).toBeUndefined()
  })

  it('locks close and Pay Later button on PaymentSurface while an action is in flight', async () => {
    const onClose = vi.fn()
    await act(async () => {
      root.render(
        <PaymentSurface
          order={BASE_ORDER}
          busy
          pendingAction="claim"
          confirmClaim
          onAction={vi.fn()}
          onClose={onClose}
          now={Date.now()}
        />,
      )
    })
    const buttons = [...host.querySelectorAll('button')]
    const closeBtn = buttons.find((b) => b.getAttribute('aria-label') === '关闭')
    const laterBtn = buttons.find((b) => b.textContent?.trim() === '稍后支付')
    const claimBtn = buttons.find((b) => b.textContent?.includes('确认已付款'))
    expect(closeBtn?.disabled).toBe(true)
    expect(laterBtn?.disabled).toBe(true)
    expect(claimBtn?.getAttribute('aria-busy')).toBe('true')
  })

  it('offers Re-login instead of Retry when SyncStatusPanel fails due to expired session', async () => {
    const login = vi.fn()
    useSyncStatus.setState({
      enabled: true,
      status: 'error',
      failure: 'unauthorized',
      pending: 1,
      lastSyncedAt: null,
      uploads: null,
    })
    await act(async () => {
      root.render(
        <AuthContextProvider value={{ enabled: true, user: null, login, logout: async () => {} }}>
          <SyncStatusPanel />
        </AuthContextProvider>,
      )
    })
    const actionBtn = host.querySelector('button')
    expect(actionBtn?.textContent).toBe('重新登录')
    await act(async () => {
      actionBtn?.click()
    })
    expect(login).toHaveBeenCalledTimes(1)
  })
})
