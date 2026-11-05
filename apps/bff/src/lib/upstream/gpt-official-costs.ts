import { log } from '../logger'

/**
 * 可选的官方花费对账。只在配了 `OPENAI_ADMIN_KEY` 时由后台面板调用，不参与选路，也不拿来扣费。
 * 管理密钥不写进日志或响应。
 */

export interface OfficialDirectCosts {
  ok: boolean
  days: Array<{ day: string; cost_micro_usd: number }>
}

type CostsFetch = (input: string, init?: RequestInit) => Promise<Response>

let costsFetch: CostsFetch = (input, init) => fetch(input, init)

export function _setOfficialCostsFetchForTesting(next?: CostsFetch): void {
  costsFetch = next ?? ((input, init) => fetch(input, init))
}

interface CostBucket {
  start_time?: unknown
  results?: Array<{ amount?: { value?: unknown } }>
}

function utcDay(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10)
}

export async function readOfficialDirectCosts(
  days: number,
  now = Date.now(),
): Promise<OfficialDirectCosts | null> {
  const adminKey = process.env.OPENAI_ADMIN_KEY?.trim()
  if (!adminKey) return null
  const start = Math.floor(now / 1000) - days * 86_400
  const url = `https://api.openai.com/v1/organization/costs?start_time=${start}&bucket_width=1d&limit=${days + 2}`
  try {
    const response = await costsFetch(url, {
      headers: { authorization: `Bearer ${adminKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return { ok: false, days: [] }
    const body = (await response.json()) as { data?: CostBucket[] }
    const buckets = Array.isArray(body.data) ? body.data : []
    return {
      ok: true,
      days: buckets.flatMap((bucket) => {
        if (typeof bucket.start_time !== 'number') return []
        const value = (bucket.results ?? []).reduce((sum, result) => {
          const amount = result.amount?.value
          return sum + (typeof amount === 'number' && Number.isFinite(amount) ? amount : 0)
        }, 0)
        return [{ day: utcDay(bucket.start_time), cost_micro_usd: Math.round(value * 1_000_000) }]
      }),
    }
  } catch (err) {
    log.warn(
      { event: 'gpt.official_costs_failed', err: err instanceof Error ? err.name : 'error' },
      'openai costs lookup failed',
    )
    return { ok: false, days: [] }
  }
}
