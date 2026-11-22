// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { beginRecharge, beginRenewal } from '../../../features/billing/orders-client'
import { authenticatedBffFetch } from '../../../lib/privateHost'

vi.mock('../../../lib/privateHost', () => ({
  authenticatedBffFetch: vi.fn(),
  getRuntimeConfig: () => ({ bff: { baseUrl: 'https://api.example.test' } }),
}))
afterEach(() => vi.resetAllMocks())

it('creates recharge in one request instead of selecting an unrelated membership from history', async () => {
  vi.mocked(authenticatedBffFetch).mockImplementation(async (_url, init) =>
    Response.json(
      init?.method === 'POST'
        ? { id: 'recharge', kind: 'recharge', amount_cents: 5000 }
        : [{ id: 'old-membership', kind: 'subscription', amount_cents: 3900, status: 'pending' }],
    ),
  )
  const result = await beginRecharge(5000, 'request')
  expect(result.id).toBe('recharge')
  expect(authenticatedBffFetch).toHaveBeenCalledTimes(1)
  expect(authenticatedBffFetch).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ kind: 'recharge', amount_cents: 5000, request_id: 'request' }),
    }),
  )
})

it('creates membership in one request without waiting on the order history', async () => {
  vi.mocked(authenticatedBffFetch).mockResolvedValue(Response.json({ id: 'membership' }))
  expect((await beginRenewal('starter', 1, 'request')).id).toBe('membership')
  expect(authenticatedBffFetch).toHaveBeenCalledTimes(1)
})

it('bounds network waiting and preserves structured order errors', async () => {
  const order = { id: 'membership', kind: 'subscription', amount_cents: 3900 }
  vi.mocked(authenticatedBffFetch).mockResolvedValue(
    Response.json({ error: 'open_order_exists', order }, { status: 409 }),
  )
  await expect(beginRecharge(5000, 'request')).rejects.toMatchObject({
    code: 'open_order_exists',
    order,
  })
  expect(vi.mocked(authenticatedBffFetch).mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
})
