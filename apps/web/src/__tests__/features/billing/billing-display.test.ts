import type { BillingSettings, LedgerEntry, ModelPrice, PlanPrice } from '@image-playground/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  contactChannels,
  contactDisplay,
  EXPIRY_WARNING_MS,
  formatExpiryCompact,
  formatExpiryCountdown,
  formatExpiryDetail,
  formatExpiryWarningBanner,
  isDiscounted,
  planDisplayName,
  resolveCreditExpiry,
  resolveTimestampExpiry,
  toUserBillingEntries,
  userBillingEntryDescription,
} from '../../../features/billing/billing-display'
import {
  availableCredits,
  type BillingSnapshot,
  normalizeAccountSnapshot,
  submissionGuard,
} from '../../../features/billing/billing-store'
import { i18next } from '../../../lib/privateHost'
import { bootstrapCapabilities } from './capabilities'

function ledgerEntry(overrides: Partial<LedgerEntry>): LedgerEntry {
  return {
    id: 'entry-1',
    user_id: 'user-1',
    bucket: 'subscription',
    entry_type: 'hold',
    amount: -300,
    task_id: 'task-1',
    reference_id: null,
    model: 'gpt-image-2',
    quantity: 3,
    operator_id: null,
    note: null,
    metadata: {},
    created_at: 1_700_000_000_000,
    ...overrides,
  }
}

beforeAll(() => bootstrapCapabilities({ 'accounts:login': true, 'billing:credits': true }))

describe('submissionGuard', () => {
  const billing = {
    status: 'ready',
    account: {
      account: {
        subscription_balance: 1_000,
        recharge_balance: 0,
        subscription_expires_at: null,
      },
      subscription: null,
      ledger: [],
      model_prices: [
        {
          model: 'gpt-image-2',
          credits_per_image: 100,
          unit: 'image',
          output_credits_per_unit: null,
          output_reserve_tokens: null,
          active: true,
          updated_at: Date.now(),
        },
        {
          model: 'grok-imagine-video',
          credits_per_image: 80,
          unit: 'second',
          output_credits_per_unit: null,
          output_reserve_tokens: null,
          active: true,
          updated_at: Date.now(),
        },
      ],
      catalog: { plans: [], settings: null, model_prices: [] },
    },
    catalog: null,
    error: null,
  } as BillingSnapshot

  it('allows submission when the balance covers the request', () => {
    expect(submissionGuard({ model: 'gpt-image-2', quantity: 3 }, billing)).toEqual({
      blocked: false,
      estimatedCredits: 300,
      availableCredits: 1_000,
    })
  })

  it('prices a per-second model by seconds and the resolution multiplier', () => {
    const rich = {
      ...billing,
      account: {
        ...billing.account!,
        account: { ...billing.account!.account!, subscription_balance: 5_000 },
      },
    }

    expect(
      submissionGuard({ model: 'grok-imagine-video', quantity: 8, unitMultiplier: 1.6 }, rich),
    ).toEqual({ blocked: false, estimatedCredits: 1_024, availableCredits: 5_000 })
  })

  it('answers the per-second unit price when asked for one second', () => {
    expect(
      submissionGuard({ model: 'grok-imagine-video', quantity: 1, unitMultiplier: 1 }, billing),
    ).toEqual({ blocked: false, estimatedCredits: 80, availableCredits: 1_000 })
  })

  it('blocks submission and offers recharge when the balance is short', () => {
    const lowBalance = {
      ...billing,
      account: {
        ...billing.account!,
        account: { ...billing.account!.account!, subscription_balance: 200 },
      },
    }

    const guard = submissionGuard({ model: 'gpt-image-2', quantity: 3 }, lowBalance)

    expect(guard).toMatchObject({
      blocked: true,
      disabledReason: '积分不足：需要 300，可用 200',
      blockedAction: { label: '充值积分' },
    })
    expect(guard.blockedAction?.run).toBeTypeOf('function')
  })

  it('does not throw when the snapshot is missing its nested credit account', () => {
    const broken = {
      ...billing,
      account: { ...billing.account!, account: undefined },
    } as unknown as BillingSnapshot

    expect(() => submissionGuard({ model: 'gpt-image-2', quantity: 1 }, broken)).not.toThrow()
    expect(submissionGuard({ model: 'gpt-image-2', quantity: 1 }, broken)).toMatchObject({
      blocked: true,
      disabledReason: '正在核算积分',
    })
    expect(availableCredits(broken.account)).toBeNull()
  })
})

describe('account snapshot', () => {
  it('keeps a normal nested snapshot', () => {
    const raw = {
      account: {
        subscription_balance: 40,
        recharge_balance: 2,
        subscription_expires_at: null,
      },
      subscription: null,
      ledger: [],
      model_prices: [],
      catalog: { plans: [], settings: null, model_prices: [] },
    }

    expect(normalizeAccountSnapshot(raw)?.account).toEqual(raw.account)
    expect(availableCredits(normalizeAccountSnapshot(raw))).toBe(42)
  })

  it('wraps a flat payload that already carries the balances', () => {
    expect(
      normalizeAccountSnapshot({
        subscription_balance: 40,
        recharge_balance: 2,
      })?.account,
    ).toEqual({
      subscription_balance: 40,
      recharge_balance: 2,
      subscription_expires_at: null,
    })
  })
  it('preserves an unmetered snapshot with a null credit account', () => {
    const raw = {
      account: null,
      unmetered: {
        user_id: 'user-1',
        daily_quota: 100,
        guaranteed_concurrency: 2,
        idle_concurrency: 1,
        enabled: true,
        updated_at: 1_700_000_000,
      },
      subscription: null,
      ledger: [],
      model_prices: [],
      catalog: { plans: [], settings: null, model_prices: [] },
    }

    const snapshot = normalizeAccountSnapshot(raw)
    expect(snapshot?.account).toBeNull()
    expect(snapshot?.unmetered?.enabled).toBe(true)
    expect(availableCredits(snapshot)).toBeNull()
    const ready: BillingSnapshot = {
      status: 'ready',
      account: snapshot,
      catalog: null,
      error: null,
    }
    expect(submissionGuard({ model: 'unpriced-model', quantity: 2 }, ready)).toEqual({
      blocked: false,
      metering: 'none',
    })
    const denied = normalizeAccountSnapshot({ ...raw, access_state: 'access_denied' })
    expect(
      submissionGuard({ model: 'unpriced-model', quantity: 2 }, { ...ready, account: denied }),
    ).toMatchObject({ blocked: true })
    expect(
      submissionGuard(
        { model: 'unpriced-model', quantity: 2 },
        {
          ...ready,
          status: 'loading',
          account: null,
        },
      ),
    ).toMatchObject({ blocked: true })
  })

  it('rejects a payload that has no balances', () => {
    expect(normalizeAccountSnapshot({ error: 'unauthorized' })).toBeNull()
    expect(normalizeAccountSnapshot(null)).toBeNull()
  })
})

describe('user ledger presentation', () => {
  it('shows one debit for a successful generation, without its zero-value confirmation', () => {
    const rows = toUserBillingEntries([
      ledgerEntry({ id: 'commit', entry_type: 'commit', amount: 0 }),
      ledgerEntry({ id: 'hold', amount: -300 }),
    ])
    expect(rows.map((row) => row.amount)).toEqual([-300])
  })

  it('shows a successful partial settlement as one net debit across both credit buckets', () => {
    const rows = toUserBillingEntries([
      ledgerEntry({
        id: 'refund-sub',
        entry_type: 'release',
        amount: 70,
        created_at: 1_700_000_001_000,
      }),
      ledgerEntry({
        id: 'refund-recharge',
        entry_type: 'release',
        bucket: 'recharge',
        amount: 20,
        created_at: 1_700_000_001_000,
      }),
      ledgerEntry({
        id: 'commit',
        entry_type: 'commit',
        amount: 0,
        created_at: 1_700_000_001_000,
      }),
      ledgerEntry({ id: 'hold-sub', amount: -100 }),
      ledgerEntry({ id: 'hold-recharge', bucket: 'recharge', amount: -20 }),
    ])
    expect(
      rows.map((row) => ({
        amount: row.amount,
        bucket: row.bucket,
        entryType: row.entry_type,
      })),
    ).toEqual([{ amount: -30, bucket: 'mixed', entryType: 'hold' }])
  })

  it('uses task spend when a ledger page contains only one settlement marker', () => {
    const settlement = {
      task_net_spend: 30,
      task_hold_status: 'committed' as const,
      task_settled_at: 1_700_000_001_000,
      created_at: 1_700_000_001_000,
    }
    const releaseOnly = toUserBillingEntries([
      ledgerEntry({ ...settlement, id: 'refund', entry_type: 'release', amount: 90 }),
    ])
    expect(releaseOnly.map(({ id, amount, entry_type }) => ({ id, amount, entry_type }))).toEqual([
      { id: 'refund', amount: -30, entry_type: 'hold' },
    ])

    const commitOnly = toUserBillingEntries([
      ledgerEntry({ ...settlement, id: 'commit', entry_type: 'commit', amount: 0 }),
    ])
    expect(commitOnly.map(({ id, amount, entry_type }) => ({ id, amount, entry_type }))).toEqual([
      { id: 'commit', amount: -30, entry_type: 'hold' },
    ])
  })

  it('merges split pages without counting overlapping ledger IDs twice or mutating them', () => {
    const firstPage = [ledgerEntry({ id: 'sub', amount: -100 })]
    const nextPage = [
      firstPage[0],
      ledgerEntry({ id: 'recharge', bucket: 'recharge', amount: -20 }),
    ]
    const rows = toUserBillingEntries([...firstPage, ...nextPage])
    expect(rows.map((row) => row.amount)).toEqual([-120])
    expect(firstPage[0].amount).toBe(-100)
  })

  it('keeps later compensation events and different generation tasks separate', () => {
    const rows = toUserBillingEntries([
      ledgerEntry({
        id: 'later',
        entry_type: 'release',
        amount: 30,
        created_at: 1_700_000_002_000,
      }),
      ledgerEntry({
        id: 'earlier',
        entry_type: 'release',
        amount: 50,
        created_at: 1_700_000_001_000,
      }),
      ledgerEntry({
        id: 'commit',
        entry_type: 'commit',
        amount: 0,
        created_at: 1_700_000_001_000,
      }),
      ledgerEntry({ id: 'one', amount: -100 }),
      ledgerEntry({ id: 'two', task_id: 'other-task', amount: -200 }),
    ])
    expect(rows.map((row) => row.amount)).toEqual([30, -50, -200])
  })

  it('retains real settlement adjustments and refunds but not zero-value expired refunds', () => {
    const rows = toUserBillingEntries([
      ledgerEntry({ id: 'refund', entry_type: 'release', amount: 100 }),
      ledgerEntry({
        id: 'expired',
        entry_type: 'release',
        amount: 0,
        note: '套餐积分已过期，未退回',
      }),
      ledgerEntry({ id: 'settlement', entry_type: 'commit', amount: -20 }),
      ledgerEntry({ id: 'adjustment', entry_type: 'adjustment', amount: 40 }),
      ledgerEntry({ id: 'hold', amount: -100 }),
    ])
    expect(rows.map((row) => row.amount)).toEqual([100, -20, 40, -100])
  })

  it('counts a per-second model in seconds', () => {
    const prices: ModelPrice[] = [
      {
        model: 'grok-imagine-video',
        credits_per_image: 80,
        unit: 'second',
        output_credits_per_unit: null,
        output_reserve_tokens: null,
        active: true,
        updated_at: Date.now(),
      },
    ]
    const entry = ledgerEntry({ model: 'grok-imagine-video', quantity: 8, amount: -1_024 })

    expect(userBillingEntryDescription(entry, prices)).toContain('8 秒')
  })

  it('names a chat turn instead of counting it in images', () => {
    const prices: ModelPrice[] = [
      {
        model: 'fixture-agent-model',
        credits_per_image: 6,
        unit: 'kilo_token',
        output_credits_per_unit: 30,
        output_reserve_tokens: 2_000,
        active: true,
        updated_at: Date.now(),
      },
    ]
    const entry = ledgerEntry({ model: 'fixture-agent-model', quantity: 1, amount: -60 })

    const description = userBillingEntryDescription(entry, prices)
    expect(description).toContain('对话')
    expect(description).not.toContain('张')
  })

  it('labels independent analysis costs even when the active price list no longer contains its model', () => {
    const entry = Object.assign(ledgerEntry({ model: 'analysis-model', quantity: 1, amount: -1 }), {
      task_kind: 'analysis' as const,
    })
    const [display] = toUserBillingEntries([entry])
    const description = userBillingEntryDescription(display!, [])
    expect(description).toContain('图片分析')
    expect(description).not.toContain('对话')
    expect(description).not.toContain('张')
  })

  it('preserves the operator reason that distinguishes paid recharge from compensation', () => {
    const entry = ledgerEntry({
      entry_type: 'recharge',
      amount: 500,
      bucket: 'recharge',
      note: '异常任务补偿',
    })

    expect(userBillingEntryDescription(entry)).toBe('异常任务补偿')
  })
})

describe('contactDisplay', () => {
  function settings(overrides: Partial<BillingSettings>): BillingSettings {
    return {
      contact_wechat: 'operator-wechat',
      payment_qr_url: '/op/payment-qr.png',
      contact_qr_url: '',
      guidance: '',
      ...overrides,
    }
  }

  it('prefers the contact QR over the wechat handle', () => {
    expect(contactDisplay(settings({ contact_qr_url: '/op/contact-qr.png' }), '兜底')).toEqual({
      kind: 'qr',
      src: '/op/contact-qr.png',
    })
  })

  it('falls back to the wechat handle when no contact QR is configured', () => {
    expect(contactDisplay(settings({}), '兜底')).toEqual({
      kind: 'wechat',
      text: 'operator-wechat',
    })
  })

  it('treats a blank contact QR as unset', () => {
    expect(contactDisplay(settings({ contact_qr_url: '   ' }), '兜底')).toEqual({
      kind: 'wechat',
      text: 'operator-wechat',
    })
  })

  it('uses the caller fallback when neither the QR nor the handle is configured', () => {
    expect(contactDisplay(settings({ contact_wechat: '' }), '兜底')).toEqual({
      kind: 'wechat',
      text: '兜底',
    })
    expect(contactDisplay(null, '兜底')).toEqual({ kind: 'wechat', text: '兜底' })
  })
})

describe('contactChannels', () => {
  function settings(overrides: Partial<BillingSettings>): BillingSettings {
    return {
      contact_wechat: 'operator-wechat',
      payment_qr_url: '/op/payment-qr.png',
      contact_qr_url: '/op/contact-qr.png',
      guidance: '备注用户名后转账',
      ...overrides,
    }
  }

  it('collects the payment QR, the contact channel, and the guidance', () => {
    expect(contactChannels(settings({}), '兜底')).toEqual({
      paymentQr: '/op/payment-qr.png',
      contact: { kind: 'qr', src: '/op/contact-qr.png' },
      guidance: '备注用户名后转账',
    })
  })

  it('treats a blank payment QR and a blank guidance as unset', () => {
    const channels = contactChannels(settings({ payment_qr_url: '   ', guidance: '  ' }), '兜底')

    expect(channels.paymentQr).toBeNull()
    expect(channels.guidance).toBeNull()
  })
})

describe('isDiscounted', () => {
  function price(overrides: Partial<PlanPrice>): PlanPrice {
    return {
      period_months: 3,
      original_price_cents: 29_900,
      discount_price_cents: null,
      discount_ends_at: null,
      effective_price_cents: 29_900,
      ...overrides,
    }
  }

  it('is true only when the effective price is below the original', () => {
    expect(isDiscounted(price({ effective_price_cents: 19_900 }))).toBe(true)
    expect(isDiscounted(price({}))).toBe(false)
  })
})

describe('planDisplayName', () => {
  afterAll(() => i18next.changeLanguage('zh-CN'))

  it('shows the English names that /pricing uses when the UI is English', async () => {
    await i18next.changeLanguage('en')
    expect(planDisplayName('starter', '入门')).toBe('Starter')
    expect(planDisplayName('standard', '标准')).toBe('Standard')
    expect(planDisplayName('professional', '专业')).toBe('Professional')
  })

  it('keeps the Chinese names when the UI is Chinese', async () => {
    await i18next.changeLanguage('zh-CN')
    expect(planDisplayName('starter', '入门')).toBe('入门')
    expect(planDisplayName('standard', '标准')).toBe('标准')
    expect(planDisplayName('professional', '专业')).toBe('专业')
  })

  it('falls back to the catalog name for ids it does not know', async () => {
    await i18next.changeLanguage('en')
    expect(planDisplayName('enterprise', '企业版')).toBe('企业版')
    expect(planDisplayName('toString', '自定义')).toBe('自定义')
    expect(planDisplayName(null, '入门')).toBe('入门')
    expect(planDisplayName(undefined, '入门')).toBe('入门')
  })
})

describe('credit expiry resolution and formatting', () => {
  const HOUR = 60 * 60 * 1000
  const DAY = 24 * HOUR
  const NOW = new Date(2026, 10, 27, 12, 0, 0).getTime()

  afterAll(() => i18next.changeLanguage('zh-CN'))

  it('switches into warning state at or below 7 days and formats countdown tiers accurately', async () => {
    expect(resolveTimestampExpiry(null, NOW)).toBeNull()
    expect(resolveTimestampExpiry(NOW, NOW)).toBeNull()
    expect(resolveTimestampExpiry(NOW - 1000, NOW)).toBeNull()

    const beyond = resolveTimestampExpiry(NOW + EXPIRY_WARNING_MS + 60_000, NOW)!
    expect(beyond.expiringSoon).toBe(false)
    expect(beyond.countdownUnit).toBe('date')
    expect(formatExpiryCountdown(beyond)).toBeNull()

    const exactSeven = resolveTimestampExpiry(NOW + 7 * DAY, NOW)!
    expect(exactSeven.expiringSoon).toBe(true)
    expect(exactSeven.countdownUnit).toBe('days')
    expect(exactSeven.countdownValue).toBe(7)

    const justUnderSeven = resolveTimestampExpiry(NOW + 7 * DAY - 5_000, NOW)!
    expect(justUnderSeven.expiringSoon).toBe(true)
    expect(justUnderSeven.countdownUnit).toBe('days')
    expect(justUnderSeven.countdownValue).toBe(7)

    const oneDay = resolveTimestampExpiry(NOW + DAY, NOW)!
    expect(oneDay.expiringSoon).toBe(true)
    expect(oneDay.countdownUnit).toBe('hours')
    expect(oneDay.countdownValue).toBe(24)

    const fiveHours = resolveTimestampExpiry(NOW + 5 * HOUR, NOW)!
    expect(fiveHours.expiringSoon).toBe(true)
    expect(fiveHours.countdownUnit).toBe('hours')
    expect(fiveHours.countdownValue).toBe(5)

    const thirtyMins = resolveTimestampExpiry(NOW + 30 * 60 * 1000, NOW)!
    expect(thirtyMins.expiringSoon).toBe(true)
    expect(thirtyMins.countdownUnit).toBe('under_hour')

    await i18next.changeLanguage('zh-CN')
    expect(formatExpiryCompact(beyond, NOW)).toBe('12/04 到期')
    expect(formatExpiryCompact(exactSeven, NOW)).toBe('剩 7 天')
    expect(formatExpiryCompact(fiveHours, NOW)).toBe('剩 5 小时')
    expect(formatExpiryCompact(thirtyMins, NOW)).toBe('不足 1 小时')

    await i18next.changeLanguage('en')
    expect(formatExpiryCompact(beyond, NOW)).toBe('Exp 12/04')
    expect(formatExpiryCompact(exactSeven, NOW)).toBe('7d left')
    expect(formatExpiryCompact(fiveHours, NOW)).toBe('5h left')
    expect(formatExpiryCompact(thirtyMins, NOW)).toBe('< 1h left')
  })

  it('includes the year for distant cross-year dates', async () => {
    await i18next.changeLanguage('zh-CN')
    const farNextYear = resolveTimestampExpiry(new Date(2027, 10, 27, 12, 0, 0).getTime(), NOW)!
    expect(formatExpiryCompact(farNextYear, NOW)).toContain('2027')
  })

  it('tracks monthly credit expiry before plan end on multi-month plans, and avoids false alarms when plan credits are 0', async () => {
    await i18next.changeLanguage('zh-CN')
    const baseAccount = {
      ledger: [],
      model_prices: [],
      catalog: { plans: [], settings: null, model_prices: [] },
    }
    const yearlySub = {
      id: 'sub-1',
      status: 'active' as const,
      plan_id: 'standard',
      period_months: 12 as const,
      starts_at: NOW - 25 * DAY,
      ends_at: NOW + 340 * DAY,
      next_grant_at: NOW + 5 * DAY,
      plan: { id: 'standard', name: '标准', monthly_credits: 1_000 },
    }

    const withCredits = resolveCreditExpiry(
      {
        ...baseAccount,
        account: {
          subscription_balance: 800,
          recharge_balance: 200,
          subscription_expires_at: NOW + 5 * DAY,
        },
        subscription: yearlySub,
      },
      NOW,
    )!
    expect(withCredits.kind).toBe('credits')
    expect(withCredits.expiringSoon).toBe(true)
    expect(withCredits.creditsAtRisk).toBe(800)
    expect(withCredits.expiresAt).toBe(NOW + 5 * DAY)
    expect(formatExpiryDetail(withCredits)).toContain('800')
    expect(formatExpiryDetail(withCredits)).toContain('到期清零')
    expect(formatExpiryWarningBanner(withCredits)).toContain('剩 5 天')

    // 本期套餐积分已用完时，不针对 5 天后的下月刷新时间报「清零警告」，改显示套餐结束日。
    const zeroPlanCredits = resolveCreditExpiry(
      {
        ...baseAccount,
        account: {
          subscription_balance: 0,
          recharge_balance: 200,
          subscription_expires_at: NOW + 5 * DAY,
        },
        subscription: yearlySub,
      },
      NOW,
    )!
    expect(zeroPlanCredits.kind).toBe('plan')
    expect(zeroPlanCredits.expiringSoon).toBe(false)
    expect(zeroPlanCredits.expiresAt).toBe(yearlySub.ends_at)
    expect(formatExpiryDetail(zeroPlanCredits)).toContain('当前套餐将于')

    // 仅充值积分、无套餐积分与订阅时不展示到期提示。
    const rechargeOnly = resolveCreditExpiry(
      {
        ...baseAccount,
        account: {
          subscription_balance: 0,
          recharge_balance: 500,
          subscription_expires_at: null,
        },
        subscription: null,
      },
      NOW,
    )
    expect(rechargeOnly).toBeNull()

    // 英文单数 1 积分时走 singular 分支。
    await i18next.changeLanguage('en')
    const singleCredit = resolveCreditExpiry(
      {
        ...baseAccount,
        account: {
          subscription_balance: 1,
          recharge_balance: 0,
          subscription_expires_at: NOW + 5 * DAY,
        },
        subscription: yearlySub,
      },
      NOW,
    )!
    expect(formatExpiryDetail(singleCredit)).toContain('1 plan credit expires')
    expect(formatExpiryWarningBanner(singleCredit)).toContain('1 plan credit clears')
  })
})
