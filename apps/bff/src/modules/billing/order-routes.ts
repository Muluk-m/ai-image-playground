import { Elysia, t } from 'elysia'
import { capabilityUnavailable, isCapabilityEnabled } from '../../lib/capabilities'
import { requireInternalService, requireUser } from '../../lib/user-auth'
import { adminOperator, validateAdminOperator } from './admin-operator'
import {
  adminOrder,
  confirmOrder,
  createOrder,
  findOrders,
  getOrder,
  listOrders,
  OpenOrderConflict,
  OrderError,
  ReceiptConflict,
  reviewOrder,
  userOrderAction,
} from './orders'

const guard = () => {
  if (!isCapabilityEnabled('billing:credits')) return capabilityUnavailable('billing:credits')
}
export const orderRoutes = new Elysia()
  .onError(({ error }) => {
    if (error instanceof OpenOrderConflict)
      return Response.json({ error: error.code, order: error.order }, { status: 409 })
    if (error instanceof ReceiptConflict)
      return Response.json({ error: error.code, order_id: error.orderId }, { status: 409 })
    if (error instanceof OrderError)
      return Response.json({ error: error.code }, { status: error.status })
  })
  .use(
    new Elysia({ prefix: '/api/billing/orders' })
      .use(requireUser)
      .onBeforeHandle(guard)
      .get('/', async ({ authUser, status }) =>
        authUser ? listOrders(authUser.id) : status(401, { error: 'unauthorized' }),
      )
      .post('/:id/claim', async ({ authUser, params, status }) =>
        authUser
          ? userOrderAction(authUser.id, params.id, 'claim')
          : status(401, { error: 'unauthorized' }),
      )
      .post('/:id/cancel', async ({ authUser, params, status }) =>
        authUser
          ? userOrderAction(authUser.id, params.id, 'cancel')
          : status(401, { error: 'unauthorized' }),
      )
      .post('/:id/refresh-code', async ({ authUser, params, status }) =>
        authUser
          ? userOrderAction(authUser.id, params.id, 'refresh-code')
          : status(401, { error: 'unauthorized' }),
      )
      .get('/:id', async ({ authUser, params, status }) =>
        authUser ? getOrder(authUser.id, params.id) : status(401, { error: 'unauthorized' }),
      )
      .post(
        '/',
        async ({ authUser, body, status }) =>
          authUser ? createOrder(authUser.id, body) : status(401, { error: 'unauthorized' }),
        {
          body: t.Union([
            t.Object({
              kind: t.Literal('recharge'),
              amount_cents: t.Integer(),
              request_id: t.String({ format: 'uuid' }),
            }),
            t.Object({
              kind: t.Optional(t.Literal('subscription')),
              plan_id: t.String({ minLength: 1, maxLength: 100 }),
              period_months: t.Union([t.Literal(1), t.Literal(3), t.Literal(12)]),
              request_id: t.String({ format: 'uuid' }),
            }),
          ]),
        },
      ),
  )

  .use(
    new Elysia({ prefix: '/internal/admin/private/billing/orders' })
      .use(requireInternalService)
      .onBeforeHandle(guard)
      .onBeforeHandle(validateAdminOperator)
      .derive(adminOperator)
      .get('/', async ({ query }) => findOrders(query), {
        query: t.Object({
          state: t.Optional(t.Literal('open')),
          q: t.Optional(t.String({ maxLength: 100 })),
          amount_cents: t.Optional(t.Numeric({ minimum: 1 })),
          received_at: t.Optional(t.Numeric({ minimum: 1 })),
          user_id: t.Optional(t.String({ maxLength: 100 })),
        }),
      })
      .get('/:id', async ({ params }) => adminOrder(params.id))
      .post(
        '/:id/review',
        async ({ params, body, operatorId }) =>
          reviewOrder(params.id, body.action, body.note, operatorId, body.rejection_message),
        {
          body: t.Object({
            action: t.UnionEnum(['note', 'reject', 'reopen']),
            rejection_message: t.Optional(t.String({ maxLength: 1000 })),
            note: t.String({ minLength: 1, maxLength: 1000 }),
          }),
        },
      )
      .post(
        '/:id/confirm',
        async ({ params, body, operatorId }) => confirmOrder(params.id, body, operatorId),
        {
          body: t.Object({
            channel: t.UnionEnum(['wechat', 'alipay']),
            receiving_account: t.String({ minLength: 1, maxLength: 200 }),
            payment_code_id: t.String({ minLength: 1, maxLength: 100 }),
            transaction_id: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
            amount_cents: t.Integer({ minimum: 1 }),
            received_at: t.Optional(t.Integer({ minimum: 1 })),
            note: t.String({ maxLength: 1000 }),
          }),
        },
      ),
  )
