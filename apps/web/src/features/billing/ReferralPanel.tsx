import type {
  ReferralRewardPage,
  ReferralSummary,
  ReferralTransferResult,
} from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import { authenticatedBffFetch, Button, bffBaseUrl, Input, Label } from '../../lib/privateHost'
import {
  formatCredits,
  formatDate,
  readBillingJson,
  refreshBillingAfterSettlement,
  useBilling,
} from './billing-store'
import { tBilling, useTranslation } from './i18n'

export function ReferralPanel({ refreshKey }: { refreshKey: number }) {
  useTranslation()
  const { status: billingStatus } = useBilling()
  const [summary, setSummary] = useState<ReferralSummary | null>(null)
  const [page, setPage] = useState<ReferralRewardPage>({ rewards: [], next_offset: null })
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const operation = useRef<string | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    const current = ++generation.current
    setLoading(true)
    setLoadingMore(false)
    void Promise.all([
      readBillingJson<ReferralSummary>('/api/billing/referrals'),
      readBillingJson<ReferralRewardPage>('/api/billing/referrals/rewards?limit=30'),
    ])
      .then(([nextSummary, nextPage]) => {
        if (current !== generation.current) return
        setSummary(nextSummary)
        setPage(nextPage)
      })
      .catch(() => {
        if (current === generation.current) setError(tBilling('referral.loadFailed'))
      })
      .finally(() => {
        if (current === generation.current) setLoading(false)
      })
    return () => {
      generation.current++
    }
  }, [refreshKey, revision])

  async function loadMore() {
    if (page.next_offset === null || loadingMore || loading || pending) return
    const current = generation.current
    setLoadingMore(true)
    setError(null)
    try {
      const next = await readBillingJson<ReferralRewardPage>(
        `/api/billing/referrals/rewards?offset=${page.next_offset}&limit=30`,
      )
      if (current === generation.current)
        setPage((previous) => ({
          rewards: [...previous.rewards, ...next.rewards],
          next_offset: next.next_offset,
        }))
    } catch {
      setError(tBilling('referral.rewardsLoadFailed'))
    } finally {
      setLoadingMore(false)
    }
  }

  async function transfer() {
    if (pending) return
    operation.current ??= crypto.randomUUID()
    setPending(true)
    setError(null)
    setNotice(null)
    try {
      const response = await authenticatedBffFetch(
        `${bffBaseUrl()}/api/billing/referrals/transfer`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operation_id: operation.current }),
        },
      )
      if (!response.ok) {
        const body = (await response.json()) as { error?: string }
        if (body.error === 'no_rewards') {
          operation.current = null
          setRevision((value) => value + 1)
          throw new Error(tBilling('referral.noRewards'))
        }
        if (body.error === 'credit_balance_overflow')
          throw new Error(tBilling('referral.balanceOverflow'))
        if (body.error === 'transfer_conflict')
          throw new Error(tBilling('referral.transferConflict'))
        throw new Error(tBilling('referral.transferUnconfirmed'))
      }
      const result = (await response.json()) as ReferralTransferResult
      operation.current = null
      generation.current++
      setSummary(result.summary)
      setNotice(
        tBilling('referral.transferred', {
          count: result.transferred_credits,
          n: formatCredits(result.transferred_credits),
        }),
      )
      setRevision((value) => value + 1)
      await refreshBillingAfterSettlement()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tBilling('referral.transferUnconfirmed'))
      setRevision((value) => value + 1)
      await refreshBillingAfterSettlement()
    } finally {
      setPending(false)
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setNotice(tBilling('referral.copied'))
    } catch {
      setError(tBilling('referral.copyFailed'))
    }
  }

  return (
    <section className="space-y-4" aria-label={tBilling('nav.referrals')}>
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-destructive/10 p-3 text-sm text-destructive"
        >
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => {
              setError(null)
              setRevision((value) => value + 1)
              void refreshBillingAfterSettlement()
            }}
          >
            {tBilling('referral.reload')}
          </Button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-success">
          {notice}
        </p>
      ) : null}
      {billingStatus === 'error' ? (
        <p role="alert" className="text-sm text-warning">
          {tBilling('referral.staleBalance')}
        </p>
      ) : null}
      {loading && !summary ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {tBilling('referral.loading')}
        </p>
      ) : null}
      {summary ? (
        <>
          <div className="space-y-4 rounded-2xl border border-border bg-muted p-4">
            <Label className="block text-sm font-medium" htmlFor="referral-share-link">
              {tBilling('referral.shareLink')}
            </Label>
            <div className="flex gap-2">
              <Input
                id="referral-share-link"
                readOnly
                value={new URL(summary.share_path, window.location.origin).href}
                className="min-w-0 flex-1"
              />
              <Button
                variant="outline"
                size="default"
                type="button"
                onClick={() => void copy(new URL(summary.share_path, window.location.origin).href)}
              >
                {tBilling('referral.copyLink')}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <span className="mr-3 text-sm text-muted-foreground">
                  {tBilling('referral.code')}
                </span>
                <code className="select-all text-base tracking-wide">{summary.code}</code>
              </div>
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={() => void copy(summary.code)}
              >
                {tBilling('referral.copyCode')}
              </Button>
            </div>
          </div>
          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-border p-4">
              <dt className="text-xs text-muted-foreground">{tBilling('referral.invitedCount')}</dt>
              <dd className="mt-2 text-headline font-semibold tabular-nums">
                {formatCredits(summary.invitation_count)}
              </dd>
            </div>
            <div className="rounded-2xl border border-primary/30 bg-primary/10 p-4">
              <dt className="text-xs text-primary">{tBilling('referral.withdrawable')}</dt>
              <dd className="mt-2 text-headline font-semibold tabular-nums">
                {formatCredits(summary.reward_balance)}
              </dd>
              <Button
                size="sm"
                type="button"
                disabled={
                  pending || loading || (summary.reward_balance === 0 && operation.current === null)
                }
                onClick={() => void transfer()}
                className="mt-3 w-full"
              >
                {tBilling(
                  pending
                    ? 'referral.transferring'
                    : operation.current
                      ? 'referral.retryTransfer'
                      : 'referral.transferAll',
                )}
              </Button>
            </div>
            <div className="rounded-2xl border border-border p-4">
              <dt className="text-xs text-muted-foreground">{tBilling('referral.totalRewards')}</dt>
              <dd className="mt-2 text-headline font-semibold tabular-nums">
                {formatCredits(summary.total_rewards)}
              </dd>
            </div>
          </dl>
          <p className="text-xs leading-6 text-muted-foreground">
            {tBilling('referral.disclaimer')}
          </p>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{tBilling('referral.rewardsTitle')}</h3>
            {page.rewards.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                {tBilling('referral.rewardsEmpty')}
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {page.rewards.map((reward) => (
                  <li key={reward.id} className="flex items-center justify-between gap-3 p-4">
                    <div>
                      <p className="text-sm text-foreground">{tBilling('referral.rewardItem')}</p>
                      <time
                        className="text-xs text-muted-foreground"
                        dateTime={new Date(reward.created_at).toISOString()}
                      >
                        {formatDate(reward.created_at)}
                      </time>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold tabular-nums text-success">
                        {tBilling('referral.rewardCredits', {
                          count: reward.credits,
                          n: formatCredits(reward.credits),
                        })}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {tBilling(
                          reward.status === 'available'
                            ? 'referral.statusAvailable'
                            : 'referral.statusTransferred',
                        )}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {page.next_offset !== null ? (
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="w-full"
                disabled={loadingMore || loading || pending}
                onClick={() => void loadMore()}
              >
                {tBilling(loadingMore ? 'referral.loadingMore' : 'referral.loadMore')}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  )
}
