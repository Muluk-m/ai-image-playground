import type { BillingOverview, SpendActivity } from '@image-playground/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OverviewPanel } from '../../../features/billing/OverviewPanel'

const OVERVIEW: BillingOverview = {
  accounts: 12,
  active_subscriptions: 3,
  subscription_credits: 4500,
  recharge_credits: 1600,
}

const ACTIVITY: SpendActivity = {
  from: '2026-01-05',
  to: '2026-01-18',
  timezone: 'Asia/Shanghai',
  days: [{ date: '2026-01-07', count: 300 }],
}

function render(activity?: SpendActivity): string {
  const client = new QueryClient()
  client.setQueryData(['private-billing', 'overview'], OVERVIEW)
  if (activity) {
    client.setQueryData(['private-billing', 'activity', '/api/private/billing/activity'], activity)
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <OverviewPanel />
    </QueryClientProvider>,
  )
}

describe('OverviewPanel', () => {
  it('shows the site-wide heat graph under the metrics', () => {
    const html = render(ACTIVITY)
    expect(html).toContain('积分账户')
    expect(html).toContain('aria-label="活跃热力图"')
    expect(html.indexOf('积分账户')).toBeLessThan(html.indexOf('aria-label="活跃热力图"'))
  })

  it('keeps the metrics readable while the heat graph is still loading', () => {
    const html = render()
    expect(html).toContain('积分账户')
    expect(html).not.toContain('aria-label="活跃热力图"')
  })
})
