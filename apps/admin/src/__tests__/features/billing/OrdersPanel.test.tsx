// @vitest-environment jsdom

import type { Catalog, OperatorPurchaseOrder } from '@image-playground/shared'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { OrdersPanel } from '@/features/billing/OrdersPanel'

const CATALOG: Catalog = {
  settings: {
    payments_enabled: true,
    contact_wechat: 'muvloom-help',
    payment_qr_url: '',
    contact_qr_url: '',
    guidance: '请按订单金额扫码付款',
  },
  plans: [
    {
      id: 'plan-basic',
      name: '入门',
      monthly_credits: 1000,
      max_concurrent_tasks: 2,
      active: true,
      sort_order: 1,
      updated_at: 1700000000000,
      prices: [
        {
          period_months: 1,
          original_price_cents: 3900,
          discount_price_cents: null,
          discount_ends_at: null,
          effective_price_cents: 3900,
        },
      ],
    },
    {
      id: 'plan-plus',
      name: '标准',
      monthly_credits: 3000,
      max_concurrent_tasks: 4,
      active: true,
      sort_order: 2,
      updated_at: 1700000000000,
      prices: [
        {
          period_months: 1,
          original_price_cents: 7900,
          discount_price_cents: null,
          discount_ends_at: null,
          effective_price_cents: 7900,
        },
      ],
    },
  ],
  model_prices: [],
}

const ORDERS: OperatorPurchaseOrder[] = [
  {
    id: 'order-review-1',
    code: 'EDK8KL',
    user_id: 'u-1',
    username: '2517906809@qq.com',
    kind: 'subscription',
    plan_id: 'plan-plus',
    plan_name: '标准',
    period_months: 1,
    subscription_action: 'upgrade',
    amount_cents: 7900,
    status: 'review',
    created_at: Date.UTC(2026, 9, 27, 0, 38, 56),
    expires_at: Date.UTC(2026, 9, 28, 0, 38, 56),
    claimed_at: Date.UTC(2026, 9, 27, 0, 40, 0),
    completed_at: null,
    ends_at: null,
    review_note: '',
    payment_code: { id: 'pc-1', channel: 'wechat', account: 'wx-main', url: '' },
    payment_history: [
      { id: 'pc-1', channel: 'wechat', account: 'wx-main', url: '', shown_at: 1700000000000 },
    ],
    payment_available: true,
    contact_qr_url: '',
    contact_wechat: '',
    notification_status: 'sent',
    receipt: null,
    history: [],
  },
  {
    id: 'order-recharge-2',
    code: '4GBJMP',
    user_id: 'u-2',
    username: 'qa-8f5eeb16@example.test',
    kind: 'recharge',
    recharge_credits: 20000,
    plan_id: null,
    plan_name: null,
    period_months: null,
    subscription_action: null,
    amount_cents: 5000,
    status: 'completed',
    created_at: Date.UTC(2026, 9, 16, 5, 27, 38),
    expires_at: Date.UTC(2026, 9, 17, 5, 27, 38),
    claimed_at: null,
    completed_at: Date.UTC(2026, 9, 16, 5, 30, 0),
    ends_at: null,
    review_note: '',
    payment_code: { id: 'pc-1', channel: 'wechat', account: 'wx-main', url: '' },
    payment_history: [],
    payment_available: true,
    contact_qr_url: '',
    contact_wechat: '',
    notification_status: 'failed',
    receipt: null,
    history: [],
  },
]

vi.mock('../../../lib/private-host', () => ({
  ApiError: class ApiError extends Error {
    body: unknown
    constructor(message: string, body?: unknown) {
      super(message)
      this.body = body
    }
  },
  apiClient: {
    get: vi.fn(async (url: string) => {
      if (url === '/api/private/billing/catalog') return CATALOG
      if (url.startsWith('/api/private/billing/orders/order-review-1')) return ORDERS[0]
      return { orders: ORDERS }
    }),
    post: vi.fn(),
  },
}))

function renderOrdersPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(['private-billing', 'catalog'], CATALOG)
  client.setQueryData(['private-orders', '', 'open'], { orders: [ORDERS[0]] })
  client.setQueryData(['private-orders', '', 'all'], { orders: ORDERS })
  client.setQueryData(['private-order', 'order-review-1'], ORDERS[0])
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <OrdersPanel />
      </TooltipProvider>
    </QueryClientProvider>,
  )
}

describe('OrdersPanel', () => {
  it('renders semantic status, notification, and item tags with theme-aware date picker', async () => {
    const { container } = renderOrdersPanel()

    expect(container.querySelector('input[type="datetime-local"]')).toBeNull()
    expect(screen.getByRole('button', { name: '大致到账时间' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: '最近订单' }))

    const reviewBadge = await screen.findByText('待核款')
    expect(reviewBadge.closest('div')).toHaveClass('text-warning')

    const completedBadge = screen.getByText('已完成')
    expect(completedBadge.closest('div')).toHaveClass('text-success')

    const sentBadge = screen.getByText('已发送')
    expect(sentBadge.closest('div')).toHaveClass('text-success')

    const failedBadge = screen.getByText('发送失败')
    expect(failedBadge.closest('div')).toHaveClass('text-danger')

    const upgradeTag = screen.getByText('立即升档')
    expect(upgradeTag.closest('div')).toHaveClass('text-info')

    const rechargeTag = screen.getByText('积分充值')
    expect(rechargeTag.closest('div')).toHaveClass('text-private')
  })

  it('opens the inspector sheet drawer and resets form state on reopen', async () => {
    renderOrdersPanel()

    fireEvent.click(await screen.findByRole('button', { name: '查看 / 核款' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '确认收款' })).toBeInTheDocument()

    const noteInput = screen.getByLabelText('核对备注 / 处置原因') as HTMLTextAreaElement
    fireEvent.change(noteInput, { target: { value: '临时备注' } })
    expect(noteInput.value).toBe('临时备注')

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '查看 / 核款' }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect((screen.getByLabelText('核对备注 / 处置原因') as HTMLTextAreaElement).value).toBe('')
  })

  it('clears search input and allows returning to the open preset from search mode', async () => {
    renderOrdersPanel()

    const queryInput = screen.getByLabelText('订单码或订单号') as HTMLInputElement
    fireEvent.change(queryInput, { target: { value: '4GBJMP' } })
    fireEvent.click(screen.getByRole('button', { name: '查找' }))

    const openRadio = screen.getByRole('radio', { name: '待付款 / 待核款' })
    expect(openRadio).toHaveAttribute('data-state', 'off')
    expect(screen.getByRole('button', { name: '清空' })).toBeInTheDocument()

    fireEvent.click(openRadio)
    expect(openRadio).toHaveAttribute('data-state', 'on')
    expect(queryInput.value).toBe('')
    expect(screen.queryByRole('button', { name: '清空' })).toBeNull()
  })
})
