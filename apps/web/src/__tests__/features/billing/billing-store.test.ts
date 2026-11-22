// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setSignedIn } from '../../../auth/loginPrompt'
import {
  getSubmissionGuard,
  loadBilling,
  readSpendActivity,
} from '../../../features/billing/billing-store'
import { bootstrapCapabilities } from './capabilities'

beforeAll(async () => {
  await bootstrapCapabilities({ 'accounts:login': true, 'billing:credits': true })
  setSignedIn(true)
})

afterAll(() => {
  setSignedIn(false)
})

function stubFetch(handler: (url: string) => Response): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => handler(String(input))) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

describe('readSpendActivity', () => {
  it('reads the activity endpoint and totals the days', async () => {
    const requested: string[] = []
    const restore = stubFetch((url) => {
      requested.push(url)
      return Response.json({
        from: '2025-09-09',
        to: '2026-09-08',
        timezone: 'Asia/Shanghai',
        days: [
          { date: '2026-09-03', count: 120 },
          { date: '2026-09-05', count: 80 },
        ],
      })
    })

    const snapshot = await readSpendActivity()
    restore()

    expect(requested).toEqual(['/api/billing/activity'])
    expect(snapshot.status).toBe('ready')
    expect(snapshot.activity).toEqual({
      from: '2025-09-09',
      to: '2026-09-08',
      timezone: 'Asia/Shanghai',
      days: [
        { date: '2026-09-03', count: 120 },
        { date: '2026-09-05', count: 80 },
      ],
    })
    expect(snapshot.total).toBe(200)
  })

  it('reports an error snapshot when the endpoint fails', async () => {
    const restore = stubFetch(() => new Response('nope', { status: 500 }))

    const snapshot = await readSpendActivity()
    restore()

    expect(snapshot.status).toBe('error')
    expect(snapshot.activity).toBeNull()
    expect(snapshot.total).toBe(0)
  })
})

describe('loadBilling', () => {
  function priceList() {
    return [
      {
        model: 'gpt-image-2',
        credits_per_image: 100,
        unit: 'image' as const,
        output_credits_per_unit: null,
        output_reserve_tokens: null,
        active: true,
        updated_at: 1,
      },
    ]
  }

  it('rejects an unreadable payload, then keeps the last good balance when another one arrives', async () => {
    let body: unknown = { error: 'unauthorized' }
    const restore = stubFetch(() => Response.json(body))

    await loadBilling()
    expect(getSubmissionGuard({ model: 'gpt-image-2', quantity: 1 })).toMatchObject({
      blocked: true,
      disabledReason: '积分账户读取失败，请刷新后重试',
    })

    body = {
      account: {
        subscription_balance: 1_000,
        recharge_balance: 0,
        subscription_expires_at: null,
      },
      subscription: null,
      ledger: [],
      model_prices: priceList(),
      catalog: { plans: [], settings: null, model_prices: [] },
    }
    await loadBilling()
    expect(getSubmissionGuard({ model: 'gpt-image-2', quantity: 1 })).toEqual({
      blocked: false,
      estimatedCredits: 100,
      availableCredits: 1_000,
    })

    body = { subscription_balance: '40' }
    await loadBilling()
    expect(getSubmissionGuard({ model: 'gpt-image-2', quantity: 1 })).toEqual({
      blocked: false,
      estimatedCredits: 100,
      availableCredits: 1_000,
    })
    restore()
  })

  it('quotes a fractional multiplier without a stray extra credit', async () => {
    const restore = stubFetch(() =>
      Response.json({
        account: {
          subscription_balance: 5_000,
          recharge_balance: 0,
          subscription_expires_at: null,
        },
        subscription: null,
        ledger: [],
        model_prices: [{ ...priceList()[0], credits_per_image: 200 }],
        catalog: { plans: [], settings: null, model_prices: [] },
      }),
    )
    await loadBilling()
    // 12 帧 GIF 是 9.8 倍：200 × 9.8 在浮点下是 1960.0000000000002。
    expect(
      getSubmissionGuard({ model: 'gpt-image-2', quantity: 1, unitMultiplier: 9.8 }),
    ).toMatchObject({ estimatedCredits: 1960 })
    restore()
  })
})
