import { accountFacts, creditAccounts, creditLedger } from '@image-playground/db/billing'
import { eq } from 'drizzle-orm'
import type { BffTransaction as Transaction } from '../../lib/billing-hooks'
import { welcomeCredits } from './config'
import { ledgerRow } from './settlement'

export async function hasCreditAccount(tx: Transaction, userId: string): Promise<boolean> {
  const [account] = await tx
    .select({ userId: creditAccounts.user_id })
    .from(creditAccounts)
    .where(eq(creditAccounts.user_id, userId))
    .limit(1)
  return Boolean(account)
}

export async function ensureAccount(tx: Transaction, userId: string, now: number): Promise<void> {
  const [existing] = await tx
    .select({ userId: creditAccounts.user_id })
    .from(creditAccounts)
    .where(eq(creditAccounts.user_id, userId))
    .limit(1)
  if (existing) return
  const [privateAccount] = await tx
    .select({ userId: accountFacts.user_id })
    .from(accountFacts)
    .where(eq(accountFacts.user_id, userId))
    .limit(1)
  if (privateAccount) throw new Error('billing_account_unavailable')
  const inserted = await tx
    .insert(creditAccounts)
    .values({ user_id: userId, recharge_balance: welcomeCredits, updated_at: now })
    .onConflictDoNothing()
    .returning({ user_id: creditAccounts.user_id })
  if (!inserted.length) return
  await tx.insert(creditLedger).values(
    ledgerRow({
      userId,
      bucket: 'recharge',
      type: 'grant',
      amount: welcomeCredits,
      now,
      referenceId: 'welcome-credit',
      note: '开户赠送积分',
    }),
  )
}

export async function lockAccount(tx: Transaction, userId: string) {
  const [account] = await tx
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.user_id, userId))
    .for('update')
    .limit(1)
  if (!account) throw new Error(`billing account missing for ${userId}`)
  return account
}
