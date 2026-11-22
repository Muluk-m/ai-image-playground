import type { Catalog, UserSummaryResponse } from '@image-playground/shared'
import { rankedPlanIds, tierOf } from '@image-playground/shared'
import { useQuery } from '@tanstack/react-query'
import { createElement, useMemo } from 'react'
import { apiClient } from '../../lib/private-host'
import type { PrivateAdminUserSummary } from '../../lib/private-overlay'
import { credits } from './shared'
import TierBadge, { TIER_COLORS } from './TierBadge'

const USER_SUMMARY_BATCH_SIZE = 50

async function fetchUserSummaries(userIds: readonly string[]): Promise<UserSummaryResponse> {
  const requests: Array<Promise<UserSummaryResponse>> = []
  for (let index = 0; index < userIds.length; index += USER_SUMMARY_BATCH_SIZE) {
    const batch = userIds.slice(index, index + USER_SUMMARY_BATCH_SIZE)
    requests.push(
      apiClient.get<UserSummaryResponse>(
        `/api/private/billing/users?ids=${batch.map(encodeURIComponent).join(',')}`,
      ),
    )
  }
  const responses = await Promise.all(requests)
  return { summaries: responses.flatMap((response) => response.summaries) }
}

function useUserSummaries(
  userIds: readonly string[],
  enabled: boolean,
): Readonly<Record<string, PrivateAdminUserSummary>> {
  const key = userIds.join(',')
  const query = useQuery({
    queryKey: ['private-billing', 'user-summaries', key],
    queryFn: () => fetchUserSummaries(userIds),
    enabled: enabled && userIds.length > 0,
    staleTime: 15_000,
  })
  const catalog = useQuery({
    queryKey: ['private-billing', 'catalog'],
    queryFn: () => apiClient.get<Catalog>('/api/private/billing/catalog'),
    enabled,
    staleTime: 60_000,
  })
  return useMemo(() => {
    const summaries: Record<string, PrivateAdminUserSummary> = {}
    const ranked = rankedPlanIds((catalog.data?.plans ?? []).filter((plan) => plan.active))
    for (const row of query.data?.summaries ?? []) {
      const total = row.subscription_balance + row.recharge_balance
      const now = Date.now()
      const expiring =
        row.subscription &&
        row.subscription.ends_at > now &&
        row.subscription.ends_at <= now + 7 * 86_400_000
      const tier = tierOf(row.subscription?.plan_id ?? null, ranked)
      summaries[row.user_id] = {
        primary: `${credits(total)} 积分`,
        secondary: row.subscription
          ? `${row.subscription.plan_name} · 至 ${new Date(row.subscription.ends_at).toLocaleDateString()}`
          : '无生效套餐',
        tone: expiring || total === 0 ? 'warning' : 'default',
        accent: TIER_COLORS[tier],
        badge: createElement(TierBadge, {
          tier,
          size: 16,
          'aria-hidden': true,
          focusable: false,
        }),
        registrationSource: row.registration_source,
        inviter: row.inviter
          ? { userId: row.inviter.user_id, username: row.inviter.username }
          : null,
      }
    }
    return summaries
  }, [catalog.data, query.data])
}

export { useUserSummaries }
