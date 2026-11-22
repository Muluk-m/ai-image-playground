import { MAX_CREDIT_BALANCE } from '@image-playground/shared'
import { Elysia, t } from 'elysia'
import { requireInternalService, requireUser } from '../../lib/user-auth'
import { adminOperator, validateAdminOperator } from './admin-operator'
import {
  getReferralPolicy,
  getReferralRewards,
  getReferralSummary,
  transferReferralRewards,
  updateReferralPolicy,
} from './referrals'
import { capabilityGuard } from './routes'

const userRoutes = new Elysia({ prefix: '/api/billing/referrals' })
  .use(requireUser)
  .onBeforeHandle(capabilityGuard)
  .get('', async ({ authUser, status }) => {
    if (!authUser) return status(401, { error: 'unauthorized' })
    try {
      return await getReferralSummary(authUser.id)
    } catch (error) {
      if (error instanceof Error && error.message === 'billing_account_unavailable')
        return status(403, { error: error.message })
      throw error
    }
  })
  .get(
    '/rewards',
    async ({ authUser, query, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      try {
        return await getReferralRewards(
          authUser.id,
          Number(query.offset ?? 0),
          Number(query.limit ?? 30),
        )
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid_pagination')
          return status(400, { error: error.message })
        throw error
      }
    },
    { query: t.Object({ offset: t.Optional(t.String()), limit: t.Optional(t.String()) }) },
  )
  .post(
    '/transfer',
    async ({ authUser, body, status }) => {
      if (!authUser) return status(401, { error: 'unauthorized' })
      try {
        return await transferReferralRewards(authUser.id, body.operation_id)
      } catch (error) {
        if (error instanceof Error && error.message === 'billing_account_unavailable')
          return status(403, { error: error.message })
        if (
          error instanceof Error &&
          ['no_rewards', 'transfer_conflict', 'credit_balance_overflow'].includes(error.message)
        ) {
          return status(409, { error: error.message })
        }
        throw error
      }
    },
    { body: t.Object({ operation_id: t.String({ format: 'uuid' }) }) },
  )

const adminRoutes = new Elysia({ prefix: '/internal/admin/private/billing/referrals' })
  .use(requireInternalService)
  .onBeforeHandle(capabilityGuard)
  .onBeforeHandle(validateAdminOperator)
  .derive(adminOperator)
  .get('/policy', () => getReferralPolicy())
  .put(
    '/policy',
    async ({ body, status, operatorId }) => {
      try {
        return await updateReferralPolicy(body, operatorId)
      } catch (error) {
        if (error instanceof Error && error.message === 'invalid_referral_policy')
          return status(400, { error: error.message })
        throw error
      }
    },
    {
      body: t.Object({
        inviter_registration_credits: t.Integer({ minimum: 0, maximum: MAX_CREDIT_BALANCE }),
        invitee_registration_credits: t.Integer({ minimum: 0, maximum: MAX_CREDIT_BALANCE }),
        paid_reward_basis_points: t.Integer({ minimum: 0, maximum: 10000 }),
        credits_per_yuan: t.Number({ exclusiveMinimum: 0, maximum: MAX_CREDIT_BALANCE }),
      }),
    },
  )

export const referralRoutes = new Elysia().use(userRoutes).use(adminRoutes)
