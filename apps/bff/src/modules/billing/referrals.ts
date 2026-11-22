import { randomBytes, randomUUID } from 'node:crypto'
import type { BillingTransaction } from '@image-playground/db/billing'
import {
  confirmedPayments,
  creditAccounts,
  creditLedger,
  referralPolicy,
  referralProfiles,
  referralRelationships,
  referralRewards,
  referralTransfers,
} from '@image-playground/db/billing'
import type {
  ReferralPolicy,
  ReferralRewardPage,
  ReferralSummary,
  ReferralTransferResult,
} from '@image-playground/shared'
import { MAX_CREDIT_BALANCE } from '@image-playground/shared'
import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db, schema as publicSchema } from '../../db/client'
import type { PrivateTaskHooks } from '../../lib/billing-hooks'
import { UserOperationError } from '../../lib/user-admin'
import { ensureAccount, hasCreditAccount, lockAccount } from './accounts'
import { ledgerRow } from './settlement'

const CONVERSION_SCALE = 10_000

type Profile = typeof referralProfiles.$inferSelect

async function policyRow(tx: BillingTransaction) {
  const [policy] = await tx.select().from(referralPolicy).where(eq(referralPolicy.id, 'default'))
  if (!policy) throw new Error('referral_policy_missing')
  return policy
}

export async function getReferralPolicy(): Promise<ReferralPolicy> {
  return db.transaction(async (tx) => {
    const policy = await policyRow(tx)
    return {
      inviter_registration_credits: policy.inviter_registration_credits,
      invitee_registration_credits: policy.invitee_registration_credits,
      paid_reward_basis_points: policy.paid_reward_basis_points,
      credits_per_yuan: policy.credits_per_yuan_scaled / CONVERSION_SCALE,
    }
  })
}

export async function updateReferralPolicy(
  input: ReferralPolicy,
  operatorId = 'admin',
): Promise<ReferralPolicy> {
  const amounts = [input.inviter_registration_credits, input.invitee_registration_credits]
  const conversion = Math.round(input.credits_per_yuan * CONVERSION_SCALE)
  if (
    amounts.some(
      (amount) => !Number.isSafeInteger(amount) || amount < 0 || amount > MAX_CREDIT_BALANCE,
    ) ||
    !Number.isSafeInteger(input.paid_reward_basis_points) ||
    input.paid_reward_basis_points < 0 ||
    input.paid_reward_basis_points > 10_000 ||
    !Number.isSafeInteger(conversion) ||
    conversion <= 0 ||
    input.credits_per_yuan > MAX_CREDIT_BALANCE ||
    conversion / CONVERSION_SCALE !== input.credits_per_yuan
  ) {
    throw new Error('invalid_referral_policy')
  }
  await db.transaction(async (tx) => {
    const now = Date.now()
    await tx
      .update(referralPolicy)
      .set({
        inviter_registration_credits: input.inviter_registration_credits,
        invitee_registration_credits: input.invitee_registration_credits,
        paid_reward_basis_points: input.paid_reward_basis_points,
        credits_per_yuan_scaled: conversion,
        updated_at: now,
      })
      .where(eq(referralPolicy.id, 'default'))
    await tx.insert(publicSchema.operator_audits).values({
      id: randomUUID(),
      operator_id: operatorId,
      action: 'billing.referral.policy.update',
      target_type: 'billing_settings',
      target_id: 'default',
      details: { ...input },
      created_at: now,
    })
  })
  return input
}

async function ensureProfile(
  tx: BillingTransaction,
  userId: string,
  now: number,
): Promise<Profile> {
  let [profile] = await tx
    .select()
    .from(referralProfiles)
    .where(eq(referralProfiles.user_id, userId))
  while (!profile) {
    const [created] = await tx
      .insert(referralProfiles)
      .values({
        user_id: userId,
        code: randomBytes(9).toString('base64url'),
        created_at: now,
      })
      .onConflictDoNothing()
      .returning()
    if (created)
      return created
      // A competing request may have created this user's profile; a code collision needs a new code.
    ;[profile] = await tx
      .select()
      .from(referralProfiles)
      .where(eq(referralProfiles.user_id, userId))
  }
  return profile
}

async function lockProfile(tx: BillingTransaction, userId: string): Promise<Profile> {
  const [profile] = await tx
    .select()
    .from(referralProfiles)
    .where(eq(referralProfiles.user_id, userId))
    .for('update')
  if (!profile) throw new Error('referral_profile_missing')
  return profile
}

function totalAfterReward(profile: Profile, credits: number): number {
  const total = profile.total_rewards + credits
  if (!Number.isSafeInteger(total)) throw new Error('credit_balance_overflow')
  return total
}

async function registrationGrant(
  tx: BillingTransaction,
  profile: Profile,
  sourceId: string,
  kind: 'registration_inviter' | 'registration_invitee',
  credits: number,
  now: number,
) {
  if (credits === 0) return
  await ensureAccount(tx, profile.user_id, now)
  const account = await lockAccount(tx, profile.user_id)
  const balance = account.recharge_balance + credits
  if (balance > MAX_CREDIT_BALANCE) throw new UserOperationError('registration_reward_unavailable')
  const total = totalAfterReward(profile, credits)
  const rewardId = randomUUID()
  await tx.insert(referralRewards).values({
    id: rewardId,
    user_id: profile.user_id,
    source_id: sourceId,
    kind,
    credits,
    created_at: now,
  })
  await tx
    .update(referralProfiles)
    .set({ total_rewards: total })
    .where(eq(referralProfiles.user_id, profile.user_id))
  await tx
    .update(creditAccounts)
    .set({ recharge_balance: balance, updated_at: now })
    .where(eq(creditAccounts.user_id, profile.user_id))
  await tx.insert(creditLedger).values(
    ledgerRow({
      userId: profile.user_id,
      bucket: 'recharge',
      type: 'grant',
      amount: credits,
      referenceId: rewardId,
      note: '邀请注册奖励',
      metadata: { reward_kind: kind },
      now,
    }),
  )
}

export async function applyRegistrationReferral(
  input: Parameters<PrivateTaskHooks['onUserCreated']>[0],
  now: number,
) {
  const code = input.referralCode?.trim()
  if (input.source !== 'self-registration' || !code) return
  const { tx, userId } = input
  const [inviter] = await tx
    .select({ userId: referralProfiles.user_id })
    .from(referralProfiles)
    .innerJoin(publicSchema.users, eq(publicSchema.users.id, referralProfiles.user_id))
    .where(and(eq(referralProfiles.code, code), eq(publicSchema.users.status, 'active')))
  if (!inviter || inviter.userId === userId || !(await hasCreditAccount(tx, inviter.userId)))
    throw new UserOperationError('invalid_referral_code')
  const policy = await policyRow(tx)
  await ensureProfile(tx, userId, now)
  // Every writer that touches both a reward profile and spendable credits locks the profile first.
  const profiles = await tx
    .select()
    .from(referralProfiles)
    .where(inArray(referralProfiles.user_id, [inviter.userId, userId]))
    .orderBy(asc(referralProfiles.user_id))
    .for('update')
  const inviterProfile = profiles.find((profile) => profile.user_id === inviter.userId)
  const inviteeProfile = profiles.find((profile) => profile.user_id === userId)
  if (!inviterProfile || !inviteeProfile) throw new Error('referral_profile_missing')
  await tx
    .insert(referralRelationships)
    .values({ user_id: userId, inviter_user_id: inviter.userId, created_at: now })
  await registrationGrant(
    tx,
    inviterProfile,
    userId,
    'registration_inviter',
    policy.inviter_registration_credits,
    now,
  )
  await registrationGrant(
    tx,
    inviteeProfile,
    userId,
    'registration_invitee',
    policy.invitee_registration_credits,
    now,
  )
  await tx.insert(publicSchema.operator_audits).values({
    id: randomUUID(),
    operator_id: 'system',
    action: 'billing.referral.register',
    target_type: 'user',
    target_id: userId,
    details: {
      inviter_user_id: inviter.userId,
      inviter_credits: policy.inviter_registration_credits,
      invitee_credits: policy.invitee_registration_credits,
    },
    created_at: now,
  })
}

/** Called only for a newly inserted payment, before the payer's credit-account lock. */
export async function applyPaymentReferral(
  tx: BillingTransaction,
  payment: typeof confirmedPayments.$inferSelect,
) {
  const policy = await policyRow(tx)
  const [relationship] = await tx
    .select()
    .from(referralRelationships)
    .where(eq(referralRelationships.user_id, payment.user_id))
  const eligibleInviter = relationship && (await hasCreditAccount(tx, relationship.inviter_user_id))
  // cents × basis points × (credits/CNY scaled by 10,000), rounded down exactly once.
  const computed = eligibleInviter
    ? (BigInt(payment.amount_cents) *
        BigInt(policy.paid_reward_basis_points) *
        BigInt(policy.credits_per_yuan_scaled)) /
      10_000_000_000n
    : 0n
  if (computed > BigInt(MAX_CREDIT_BALANCE)) throw new Error('credit_balance_overflow')
  const credits = Number(computed)
  if (relationship && credits > 0) {
    const profile = await lockProfile(tx, relationship.inviter_user_id)
    const balance = profile.reward_balance + credits
    if (balance > MAX_CREDIT_BALANCE) throw new Error('credit_balance_overflow')
    await tx
      .update(referralProfiles)
      .set({ reward_balance: balance, total_rewards: totalAfterReward(profile, credits) })
      .where(eq(referralProfiles.user_id, profile.user_id))
    await tx.insert(referralRewards).values({
      id: randomUUID(),
      user_id: profile.user_id,
      kind: 'payment',
      source_id: payment.id,
      credits,
      created_at: payment.created_at,
    })
  }
  const snapshot = {
    inviter_user_id: relationship?.inviter_user_id ?? null,
    paid_reward_basis_points: policy.paid_reward_basis_points,
    credits_per_yuan_scaled: policy.credits_per_yuan_scaled,
    reward_credits: credits,
  }
  await tx.update(confirmedPayments).set(snapshot).where(eq(confirmedPayments.id, payment.id))
  return { ...payment, ...snapshot }
}

export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
  return db.transaction(async (tx) => {
    if (!(await hasCreditAccount(tx, userId))) throw new Error('billing_account_unavailable')
    await ensureProfile(tx, userId, Date.now())
    const [profile] = await tx
      .select()
      .from(referralProfiles)
      .where(eq(referralProfiles.user_id, userId))
      .for('share')
    if (!profile) throw new Error('referral_profile_missing')
    const [invitations] = await tx
      .select({ count: count() })
      .from(referralRelationships)
      .where(eq(referralRelationships.inviter_user_id, userId))
    return {
      code: profile.code,
      share_path: `/?ref=${encodeURIComponent(profile.code)}`,
      invitation_count: invitations.count,
      reward_balance: profile.reward_balance,
      total_rewards: profile.total_rewards,
    }
  })
}

export async function getReferralRewards(
  userId: string,
  offset: number,
  limit: number,
): Promise<ReferralRewardPage> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new Error('invalid_pagination')
  }
  const rows = await db
    .select({
      id: referralRewards.id,
      credits: referralRewards.credits,
      created_at: referralRewards.created_at,
      transfer_id: referralRewards.transfer_id,
    })
    .from(referralRewards)
    .where(and(eq(referralRewards.user_id, userId), eq(referralRewards.kind, 'payment')))
    .orderBy(desc(referralRewards.created_at), desc(referralRewards.id))
    .offset(offset)
    .limit(limit + 1)
  return {
    rewards: rows.slice(0, limit).map((row) => ({
      id: row.id,
      credits: row.credits,
      created_at: row.created_at,
      status: row.transfer_id === null ? 'available' : 'transferred',
    })),
    next_offset: rows.length > limit ? offset + limit : null,
  }
}

export async function transferReferralRewards(
  userId: string,
  operationId: string,
): Promise<ReferralTransferResult> {
  const transferred = await db.transaction(async (tx) => {
    const now = Date.now()
    if (!(await hasCreditAccount(tx, userId))) throw new Error('billing_account_unavailable')
    await ensureProfile(tx, userId, now)
    const profile = await lockProfile(tx, userId)
    const [previous] = await tx
      .select()
      .from(referralTransfers)
      .where(eq(referralTransfers.id, operationId))
    if (previous) {
      if (previous.user_id !== userId) throw new Error('transfer_conflict')
      return previous.credits
    }
    const credits = profile.reward_balance
    if (credits === 0) throw new Error('no_rewards')
    await ensureAccount(tx, userId, now)
    const account = await lockAccount(tx, userId)
    const balance = account.recharge_balance + credits
    if (balance > MAX_CREDIT_BALANCE) throw new Error('credit_balance_overflow')
    const [created] = await tx
      .insert(referralTransfers)
      .values({
        id: operationId,
        user_id: userId,
        credits,
        created_at: now,
      })
      .onConflictDoNothing()
      .returning({ id: referralTransfers.id })
    if (!created) throw new Error('transfer_conflict')
    await tx
      .update(referralProfiles)
      .set({ reward_balance: 0 })
      .where(eq(referralProfiles.user_id, userId))
    await tx
      .update(creditAccounts)
      .set({ recharge_balance: balance, updated_at: now })
      .where(eq(creditAccounts.user_id, userId))
    await tx
      .update(referralRewards)
      .set({ transfer_id: operationId })
      .where(
        and(
          eq(referralRewards.user_id, userId),
          eq(referralRewards.kind, 'payment'),
          isNull(referralRewards.transfer_id),
        ),
      )
    await tx.insert(creditLedger).values(
      ledgerRow({
        userId,
        bucket: 'recharge',
        type: 'grant',
        amount: credits,
        referenceId: operationId,
        note: '充值返利积分提现',
        metadata: { reward_kind: 'transfer' },
        now,
      }),
    )
    await tx.insert(publicSchema.operator_audits).values({
      id: randomUUID(),
      operator_id: userId,
      action: 'billing.referral.transfer',
      target_type: 'user',
      target_id: userId,
      details: { operation_id: operationId, credits },
      created_at: now,
    })
    return credits
  })
  return { transferred_credits: transferred, summary: await getReferralSummary(userId) }
}
