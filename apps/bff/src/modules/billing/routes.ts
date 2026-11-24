import { MAX_CREDIT_BALANCE } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { capabilityUnavailable, isCapabilityEnabled } from '../../lib/capabilities'
import { requireInternalService, requireUser } from '../../lib/user-auth'
import { adminOperator, validateAdminOperator } from './admin-operator'
import { InvalidRangeError } from './calculations'
import {
  adjustSubscriptionCredits,
  adjustSubscriptionExpiry,
  grantSubscription,
  updatePlan,
  updateSettings,
} from './commerce'
import { scanDueAccounts } from './entitlement'
import { adjustRechargeCredits } from './ledger'
import { getConfirmedPayments, isHistoricalPayment } from './payments'
import { getCatalog, getPublicCatalog, updateModelPrice } from './pricing'
import {
  getAccountSnapshot,
  getBillingOverview,
  getChatUsageSummary,
  getLedgerPage,
  getSpendActivity,
  getUserSummaries,
} from './queries'

const activityRange = {
  query: t.Object({
    from: t.Optional(t.String()),
    to: t.Optional(t.String()),
  }),
}

const spendActivity = (userId: string | undefined, query: { from?: string; to?: string }) =>
  getSpendActivity({ userId, from: query.from, to: query.to }).catch((error) => {
    if (error instanceof InvalidRangeError) return null
    throw error
  })

export const capabilityGuard = () => {
  if (!isCapabilityEnabled('billing:credits')) return capabilityUnavailable('billing:credits')
}

const publicRoutes = new Elysia({ prefix: '/api/billing' })
  .onBeforeHandle(capabilityGuard)
  .get('/public-catalog', ({ set }) => {
    set.headers['cache-control'] = 'no-store'
    return getPublicCatalog()
  })

const userRoutes = new Elysia({ prefix: '/api/billing' })
  .use(requireUser)
  .onBeforeHandle(capabilityGuard)
  .get('/account', async ({ authUser, status }) => {
    if (!authUser) return status(401, { error: 'unauthorized' })
    const [account, catalog] = await Promise.all([getAccountSnapshot(authUser.id), getCatalog()])
    return { ...account, catalog }
  })
  .get('/catalog', () => getCatalog())
  .get(
    '/activity',
    async ({ authUser, query, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      return (await spendActivity(authUser.id, query)) ?? status(400, { error: 'invalid_range' })
    },
    activityRange,
  )
  .get(
    '/ledger',
    async ({ authUser, query, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      try {
        return await getLedgerPage(
          authUser.id,
          Number(query.offset ?? 0),
          Number(query.limit ?? 100),
        )
      } catch {
        return status(400, { error: 'invalid_pagination' })
      }
    },
    {
      query: t.Object({
        offset: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )

const period = t.Union([t.Literal(1), t.Literal(3), t.Literal(12)])
const paymentInput = t.Nullable(
  t.Object({
    operation_id: t.String({ format: 'uuid' }),
    amount_cents: t.Integer({ minimum: 1, maximum: MAX_CREDIT_BALANCE }),
  }),
)

const internalRoutes = new Elysia({ prefix: '/internal/admin/private/billing' })
  .use(requireInternalService)
  .onBeforeHandle(capabilityGuard)
  .onBeforeHandle(validateAdminOperator)
  .derive(adminOperator)
  .get('/catalog', () => getCatalog({ includeInactivePlans: true }))
  .get('/overview', () => getBillingOverview())
  .get(
    '/activity',
    async ({ query, status }) =>
      (await spendActivity(undefined, query)) ?? status(400, { error: 'invalid_range' }),
    activityRange,
  )
  .get('/chat-usage', () => getChatUsageSummary())
  .get('/users/:id/chat-usage', ({ params }) => getChatUsageSummary(params.id), {
    params: t.Object({ id: t.String({ minLength: 1 }) }),
  })
  .get('/users', ({ query }) => getUserSummaries(query.ids ? query.ids.split(',') : []), {
    query: t.Object({ ids: t.Optional(t.String({ maxLength: 10_000 })) }),
  })
  .get(
    '/users/:id',
    async ({ params }) => ({
      ...(await getAccountSnapshot(params.id)),
      payments: await getConfirmedPayments(params.id),
    }),
    { params: t.Object({ id: t.String({ minLength: 1 }) }) },
  )
  .get(
    '/users/:id/activity',
    async ({ params, query, status }) =>
      (await spendActivity(params.id, query)) ?? status(400, { error: 'invalid_range' }),
    { params: t.Object({ id: t.String({ minLength: 1 }) }), ...activityRange },
  )
  .get(
    '/users/:id/ledger',
    async ({ params, query, status }) => {
      try {
        return await getLedgerPage(params.id, Number(query.offset ?? 0), Number(query.limit ?? 100))
      } catch {
        return status(400, { error: 'invalid_pagination' })
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      query: t.Object({
        offset: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )
  .post(
    '/users/:id/recharge',
    async ({ params, body, status, operatorId }) => {
      try {
        if (body.payment && !(await isHistoricalPayment(params.id, body.payment.operation_id)))
          return status(409, { error: 'orders_required' })
        return await adjustRechargeCredits({
          operatorId,
          userId: params.id,
          amount: body.amount,
          reason: body.reason,
          payment: body.payment,
        })
      } catch (error) {
        const code = error instanceof Error ? error.message : 'billing_operation_failed'
        if (code === 'payment_conflict') return status(409, { error: code })
        if (code === 'insufficient_recharge_credits') return status(409, { error: code })
        const invalid =
          code === 'invalid_amount' ||
          code === 'reason_required' ||
          code === 'invalid_payment' ||
          code === 'credit_balance_overflow'
        return status(invalid ? 400 : 500, { error: code })
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({
        amount: t.Integer({ minimum: -MAX_CREDIT_BALANCE, maximum: MAX_CREDIT_BALANCE }),
        reason: t.String({ minLength: 1, maxLength: 500 }),
        payment: paymentInput,
      }),
    },
  )
  .post(
    '/users/:id/subscription-credits',
    async ({ params, body, status, operatorId }) => {
      try {
        return await adjustSubscriptionCredits({
          operatorId,
          userId: params.id,
          amount: body.amount,
          reason: body.reason,
        })
      } catch (error) {
        const code = error instanceof Error ? error.message : 'billing_operation_failed'
        if (
          code === 'insufficient_subscription_credits' ||
          code === 'no_active_subscription' ||
          code === 'billing_account_unavailable'
        )
          return status(409, { error: code })
        const invalid =
          code === 'invalid_amount' ||
          code === 'reason_required' ||
          code === 'credit_balance_overflow'
        return status(invalid ? 400 : 500, { error: code })
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({
        amount: t.Integer({ minimum: -MAX_CREDIT_BALANCE, maximum: MAX_CREDIT_BALANCE }),
        reason: t.String({ minLength: 1, maxLength: 500 }),
      }),
    },
  )
  .post(
    '/users/:id/subscriptions',
    async ({ params, body, status, operatorId }) => {
      try {
        if (body.payment && !(await isHistoricalPayment(params.id, body.payment.operation_id)))
          return status(409, { error: 'orders_required' })
        return await grantSubscription({
          operatorId,
          userId: params.id,
          planId: body.plan_id,
          periodMonths: body.period_months,
          startsAt: body.starts_at,
          reason: body.reason,
          payment: body.payment,
        })
      } catch (error) {
        const code = error instanceof Error ? error.message : 'billing_operation_failed'
        if (code === 'payment_conflict') return status(409, { error: code })
        return status(code === 'plan_not_found' ? 404 : 400, { error: code })
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({
        plan_id: t.String({ minLength: 1 }),
        period_months: period,
        starts_at: t.Number(),
        reason: t.String({ minLength: 1, maxLength: 500 }),
        payment: paymentInput,
      }),
    },
  )
  .post(
    '/subscriptions/:id/expiry',
    async ({ params, body, status, operatorId }) => {
      try {
        return await adjustSubscriptionExpiry({
          operatorId,
          subscriptionId: params.id,
          endsAt: body.ends_at,
          reason: body.reason,
        })
      } catch (error) {
        const code = error instanceof Error ? error.message : 'billing_operation_failed'
        return status(code === 'subscription_not_found' ? 404 : 400, { error: code })
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({
        ends_at: t.Number(),
        reason: t.String({ minLength: 1, maxLength: 500 }),
      }),
    },
  )
  .put(
    '/models/:model',
    async ({ params, body, status, operatorId }) => {
      try {
        await updateModelPrice({
          operatorId,
          model: params.model,
          creditsPerUnit: body.credits_per_image,
          unit: body.unit,
          outputCreditsPerUnit: body.output_credits_per_unit,
          outputReserveTokens: body.output_reserve_tokens,
          cachedInputPricePercent: body.cached_input_price_percent,
        })
        return { ok: true }
      } catch (error) {
        return status(400, {
          error: error instanceof Error ? error.message : 'billing_operation_failed',
        })
      }
    },
    {
      params: t.Object({ model: t.String({ minLength: 1 }) }),
      body: t.Object({
        credits_per_image: t.Number({ minimum: 1 }),
        // 上下架归公开库的「模型」页；还没刷新的旧后台页面仍会带上它，这里收下不用。
        active: t.Optional(t.Boolean()),
        unit: t.Optional(t.UnionEnum(['image', 'second', 'kilo_token'])),
        output_credits_per_unit: t.Optional(t.Number({ minimum: 1 })),
        output_reserve_tokens: t.Optional(t.Number({ minimum: 1 })),
        cached_input_price_percent: t.Optional(t.Integer({ minimum: 0, maximum: 100 })),
      }),
    },
  )
  .put(
    '/plans/:id',
    async ({ params, body, status, operatorId }) => {
      try {
        const result = await updatePlan({
          operatorId,
          id: params.id,
          name: body.name,
          monthlyCredits: body.monthly_credits,
          maxConcurrentTasks: body.max_concurrent_tasks,
          active: body.active,
          sortOrder: body.sort_order,
          prices: body.prices.map((price) => ({
            periodMonths: price.period_months,
            originalPriceCents: price.original_price_cents,
            discountPriceCents: price.discount_price_cents ?? null,
            discountEndsAt: price.discount_ends_at ?? null,
          })),
        })
        return { ok: true, plan_id: result }
      } catch (error) {
        return status(400, {
          error: error instanceof Error ? error.message : 'billing_operation_failed',
        })
      }
    },
    {
      params: t.Object({ id: t.String({ minLength: 1 }) }),
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        monthly_credits: t.Integer({ minimum: 1, maximum: MAX_CREDIT_BALANCE }),
        max_concurrent_tasks: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
        active: t.Boolean(),
        sort_order: t.Number(),
        prices: t.Array(
          t.Object({
            period_months: period,
            original_price_cents: t.Number({ minimum: 0 }),
            discount_price_cents: t.Optional(t.Union([t.Number({ minimum: 0 }), t.Null()])),
            discount_ends_at: t.Optional(t.Union([t.Number(), t.Null()])),
          }),
        ),
      }),
    },
  )
  .put(
    '/settings',
    async ({ body, operatorId }) => {
      await updateSettings({
        operatorId,
        contactWechat: body.contact_wechat,
        paymentQrUrl: body.payment_qr_url,
        contactQrUrl: body.contact_qr_url,
        guidance: body.guidance,
        paymentsEnabled: body.payments_enabled,
        paymentChannel: body.payment_channel,
        receivingAccount: body.receiving_account,
      })
      return { ok: true }
    },
    {
      body: t.Object({
        contact_wechat: t.String({ maxLength: 200 }),
        payment_qr_url: t.String({ maxLength: 2000 }),
        contact_qr_url: t.String({ maxLength: 2000 }),
        guidance: t.String({ maxLength: 2000 }),
        payments_enabled: t.Optional(t.Boolean()),
        payment_channel: t.Optional(t.UnionEnum(['wechat', 'alipay'])),
        receiving_account: t.Optional(t.String({ maxLength: 200 })),
      }),
    },
  )
  .post('/maintenance', async () => ({ processed: await scanDueAccounts() }))

export const billingRoutes = new Elysia().use(publicRoutes).use(userRoutes).use(internalRoutes)
