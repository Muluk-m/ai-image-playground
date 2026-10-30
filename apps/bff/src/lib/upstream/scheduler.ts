import { hostname } from 'node:os'
import { and, asc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { log } from '../logger'

/**
 * 跨 worker 的上游配额。同一环境里所有 worker 进程在公开库上按行锁抢额度：
 *
 * - 每分钟张数（`imagesPerMinute`）：最近 60 秒内在这个桶上发出的张数合计不超过上限（滑动窗口，
 *   任意一分钟都不超，不像令牌桶能先攒满再连发）。张数一律按发出时扣，请求失败也不退；只有请求
 *   根本没发出去才退（{@link SchedulerLease.release} 的 `refund`）。
 * - 同时在途（`concurrency`）：还没释放的请求数不超过上限。
 *
 * 一次请求要占的几个桶在同一事务里按键名顺序加锁、一起拿到或一起拿不到，不会占着一个桶等另一个。
 * 进程死掉留下的租约靠心跳过期回收：在途名额收回，张数仍按发出算。上游回 429 时整个桶停发一段时间。
 */
export interface SchedulerBucket {
  key: string
  imagesPerMinute?: number
  concurrency?: number
  /** 上游回 429 时冷却这个桶。 */
  coolDownOnRateLimit?: boolean
}

export type AcquireResult = { granted: true } | { granted: false; retryAfterMs: number }

export const SCHEDULER_WINDOW_MS = 60_000
/** 只因同时在途满而等时，多久再看一眼；释放不发通知，靠轮询。 */
const CONCURRENCY_RETRY_MS = 500
const MAX_RETRY_MS = 5_000

const WORKER_ID = `${hostname()}:${process.pid}`

let now = (): number => Date.now()
/** 测试时钟比真实时间快几倍；等额度时的真实睡眠按它缩短。 */
let clockSpeed = 1

/** 测试用：换掉时钟（`speed` 为它比真实时间快几倍）。不传恢复真实时钟。 */
export function _setSchedulerClockForTesting(clock?: () => number, speed = 1): void {
  now = clock ?? (() => Date.now())
  clockSpeed = clock ? speed : 1
}

let sleep = abortableSleep

/** 测试用：换掉等额度时的睡眠（配合假时钟，让时间只在睡眠时前进）。不传恢复真实睡眠。 */
export function _setSchedulerSleepForTesting(
  fake?: (ms: number, signal?: AbortSignal) => Promise<void>,
): void {
  sleep = fake ?? abortableSleep
}

const namespaced = (key: string): string => `${config.scheduler.namespace}:${key}`

/**
 * 原子地为 `attemptId` 在所有 `buckets` 上各占一份额度（`images` 张、1 个在途名额）。同一个 attemptId
 * 重复调用不会多扣：已经拿到过就直接返回拿到。拿不到时什么都不占，返回建议多久后再试。
 */
export async function acquireSchedulerSlots(
  attemptId: string,
  buckets: readonly SchedulerBucket[],
  images: number,
): Promise<AcquireResult> {
  if (buckets.length === 0) return { granted: true }
  const specs = [...buckets]
    .map((bucket) => ({ ...bucket, key: namespaced(bucket.key) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const keys = specs.map((spec) => spec.key)
  return db.transaction(async (tx) => {
    await tx
      .insert(schema.scheduler_buckets)
      .values(keys.map((key) => ({ key, updated_at: now() })))
      .onConflictDoNothing()
    const rows = await tx
      .select()
      .from(schema.scheduler_buckets)
      .where(inArray(schema.scheduler_buckets.key, keys))
      .orderBy(asc(schema.scheduler_buckets.key))
      .for('update')
    // 拿到锁之后再取时间：排在锁后面等的事务若用进事务时的时间，会把租约记早，窗口就漏算了。
    const at = now()
    const existing = await tx
      .select({ key: schema.scheduler_leases.bucket_key })
      .from(schema.scheduler_leases)
      .where(eq(schema.scheduler_leases.attempt_id, attemptId))
    if (existing.length > 0) return { granted: true } as const

    // 心跳停了的租约：在途名额收回；张数照旧按发出时算在窗口里。
    await tx
      .update(schema.scheduler_leases)
      .set({ released_at: at })
      .where(
        and(
          inArray(schema.scheduler_leases.bucket_key, keys),
          isNull(schema.scheduler_leases.released_at),
          lt(schema.scheduler_leases.heartbeat_at, at - config.scheduler.leaseTtlMs),
        ),
      )
    // 已释放且滑出窗口的行不再影响任何判断。
    await tx
      .delete(schema.scheduler_leases)
      .where(
        and(
          inArray(schema.scheduler_leases.bucket_key, keys),
          sql`${schema.scheduler_leases.released_at} is not null`,
          lt(schema.scheduler_leases.acquired_at, at - SCHEDULER_WINDOW_MS),
        ),
      )
    const live = await tx
      .select({
        key: schema.scheduler_leases.bucket_key,
        images: schema.scheduler_leases.images,
        acquired_at: schema.scheduler_leases.acquired_at,
        released_at: schema.scheduler_leases.released_at,
      })
      .from(schema.scheduler_leases)
      .where(
        and(
          inArray(schema.scheduler_leases.bucket_key, keys),
          sql`(${schema.scheduler_leases.released_at} is null or ${schema.scheduler_leases.acquired_at} > ${new Date(at - SCHEDULER_WINDOW_MS).toISOString()})`,
        ),
      )
      .orderBy(asc(schema.scheduler_leases.acquired_at))

    let retryAfterMs = 0
    for (const spec of specs) {
      const row = rows.find((candidate) => candidate.key === spec.key)
      if (row?.cooldown_until && row.cooldown_until > at) {
        retryAfterMs = Math.max(retryAfterMs, row.cooldown_until - at)
      }
      const leases = live.filter((lease) => lease.key === spec.key)
      if (spec.concurrency !== undefined) {
        const inFlight = leases.filter((lease) => lease.released_at === null).length
        if (inFlight >= spec.concurrency)
          retryAfterMs = Math.max(retryAfterMs, CONCURRENCY_RETRY_MS)
      }
      if (spec.imagesPerMinute !== undefined) {
        // 一次要的张数超过上限时等窗口清空再发，否则永远拿不到。
        const need = Math.min(images, spec.imagesPerMinute)
        const windowed = leases.filter((lease) => lease.acquired_at > at - SCHEDULER_WINDOW_MS)
        let used = windowed.reduce((sum, lease) => sum + lease.images, 0)
        if (used + need > spec.imagesPerMinute) {
          // 等最早的几张滑出窗口，腾够这次要的张数。
          let freeAt = at
          for (const lease of windowed) {
            used -= lease.images
            freeAt = lease.acquired_at + SCHEDULER_WINDOW_MS
            if (used + need <= spec.imagesPerMinute) break
          }
          retryAfterMs = Math.max(retryAfterMs, freeAt - at)
        }
      }
    }
    if (retryAfterMs > 0) return { granted: false, retryAfterMs } as const

    await tx.insert(schema.scheduler_leases).values(
      specs.map((spec) => ({
        attempt_id: attemptId,
        bucket_key: spec.key,
        images,
        worker_id: WORKER_ID,
        acquired_at: at,
        heartbeat_at: at,
      })),
    )
    return { granted: true } as const
  })
}

/** 请求结束：在途名额还回去。`refund` 表示请求根本没发出去，这次的张数也一并退回。重复调用无副作用。 */
export async function releaseSchedulerSlots(
  attemptId: string,
  options: { refund?: boolean } = {},
): Promise<void> {
  if (options.refund) {
    await db
      .delete(schema.scheduler_leases)
      .where(eq(schema.scheduler_leases.attempt_id, attemptId))
    return
  }
  await db
    .update(schema.scheduler_leases)
    .set({ released_at: now() })
    .where(
      and(
        eq(schema.scheduler_leases.attempt_id, attemptId),
        isNull(schema.scheduler_leases.released_at),
      ),
    )
}

/** 续上这些请求的心跳，让别的 worker 不把它们当成死租约收走。 */
export async function heartbeatSchedulerSlots(attemptIds: readonly string[]): Promise<void> {
  if (attemptIds.length === 0) return
  await db
    .update(schema.scheduler_leases)
    .set({ heartbeat_at: now() })
    .where(
      and(
        inArray(schema.scheduler_leases.attempt_id, [...attemptIds]),
        isNull(schema.scheduler_leases.released_at),
      ),
    )
}

/** 上游回了 429：这些桶在冷却期内谁也拿不到额度（相当于把桶清零），冷却只延长不缩短。 */
export async function coolDownSchedulerBuckets(
  bucketKeys: readonly string[],
  cooldownMs: number = config.scheduler.rateLimitCooldownMs,
): Promise<void> {
  if (bucketKeys.length === 0) return
  const at = now()
  const until = at + cooldownMs
  const keys = bucketKeys.map(namespaced)
  await db
    .insert(schema.scheduler_buckets)
    .values(keys.map((key) => ({ key, cooldown_until: until, updated_at: at })))
    .onConflictDoUpdate({
      target: schema.scheduler_buckets.key,
      set: {
        cooldown_until: sql`greatest(coalesce(${schema.scheduler_buckets.cooldown_until}, excluded.cooldown_until), excluded.cooldown_until)`,
        updated_at: at,
      },
    })
}

/** 一个桶当前的用量，测试与排查用。 */
export async function schedulerBucketUsage(
  key: string,
): Promise<{ inFlight: number; imagesLastMinute: number; cooldownUntil: number | null }> {
  const at = now()
  const fullKey = namespaced(key)
  const [bucket] = await db
    .select()
    .from(schema.scheduler_buckets)
    .where(eq(schema.scheduler_buckets.key, fullKey))
  const leases = await db
    .select()
    .from(schema.scheduler_leases)
    .where(eq(schema.scheduler_leases.bucket_key, fullKey))
  return {
    inFlight: leases.filter(
      (lease) =>
        lease.released_at === null && lease.heartbeat_at >= at - config.scheduler.leaseTtlMs,
    ).length,
    imagesLastMinute: leases
      .filter((lease) => lease.acquired_at > at - SCHEDULER_WINDOW_MS)
      .reduce((sum, lease) => sum + lease.images, 0),
    cooldownUntil:
      bucket?.cooldown_until && bucket.cooldown_until > at ? bucket.cooldown_until : null,
  }
}

// ---- 进程内的租约句柄：等额度、心跳、释放 ----

const active = new Set<string>()
let heartbeatTimer: ReturnType<typeof setInterval> | undefined

function syncHeartbeat(): void {
  if (active.size > 0 && !heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      heartbeatSchedulerSlots([...active]).catch((err) =>
        log.warn(
          { event: 'upstream.scheduler_heartbeat_failed', err },
          'scheduler heartbeat failed',
        ),
      )
    }, config.scheduler.heartbeatMs)
    heartbeatTimer.unref?.()
  } else if (active.size === 0 && heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }
}

export interface SchedulerLease {
  readonly attemptId: string
  /** 等了多久才拿到额度。 */
  readonly waitedMs: number
  release(options?: { refund?: boolean }): Promise<void>
  /** 上游回了 429：把标了 coolDownOnRateLimit 的桶冷却。 */
  rateLimited(): Promise<void>
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 一直等到拿到额度或 `signal` 中止。中止时抛出 signal 的 reason，什么都不占。
 * 数据库出错时放行（记日志、不占额度）：配额是保护上游的闸，不该让一次查询失败把生成卡死。
 */
export async function waitForSchedulerSlots(
  buckets: readonly SchedulerBucket[],
  images: number,
  signal?: AbortSignal,
): Promise<SchedulerLease | undefined> {
  if (buckets.length === 0) return undefined
  const attemptId = crypto.randomUUID()
  const started = now()
  let attempts = 0
  for (;;) {
    attempts += 1
    if (signal?.aborted) throw signal.reason
    let result: AcquireResult
    try {
      result = await acquireSchedulerSlots(attemptId, buckets, images)
    } catch (err) {
      if (signal?.aborted) throw signal.reason
      log.warn(
        { event: 'upstream.scheduler_acquire_failed', err, buckets: buckets.map((b) => b.key) },
        'scheduler acquire failed; sending without quota',
      )
      return undefined
    }
    if (result.granted) break
    const sleepMs = Math.min(result.retryAfterMs, MAX_RETRY_MS) / clockSpeed
    await sleep(Math.max(sleepMs, 50), signal)
  }
  const waitedMs = now() - started
  if (attempts > 1) {
    log.info(
      { event: 'upstream.scheduler_waited', waitedMs, images, buckets: buckets.map((b) => b.key) },
      'waited for upstream quota',
    )
  }
  active.add(attemptId)
  syncHeartbeat()
  let released = false
  return {
    attemptId,
    waitedMs,
    async release(options) {
      if (released) return
      released = true
      active.delete(attemptId)
      syncHeartbeat()
      try {
        await releaseSchedulerSlots(attemptId, options)
      } catch (err) {
        // 释放失败的租约会在心跳过期后被回收。
        log.warn({ event: 'upstream.scheduler_release_failed', err }, 'scheduler release failed')
      }
    },
    async rateLimited() {
      const keys = buckets.filter((bucket) => bucket.coolDownOnRateLimit).map((b) => b.key)
      if (keys.length === 0) return
      log.warn(
        { event: 'upstream.scheduler_rate_limited', buckets: keys },
        'upstream 429; cooling down',
      )
      try {
        await coolDownSchedulerBuckets(keys)
      } catch (err) {
        log.warn({ event: 'upstream.scheduler_cooldown_failed', err }, 'scheduler cooldown failed')
      }
    },
  }
}

/**
 * GPT Image 走通用网关时要占哪些桶。UPSTREAM_BASE_URL 指向 api.openai.com 即直连：每模型每分钟张数、
 * 直连合计在途数，以及（配了的话）整个组织每分钟张数；否则是 sub2api，只限本环境合计在途数，
 * 没配（0）就不限。
 */
export function gptSchedulerBuckets(model: string, baseUrl: string): SchedulerBucket[] {
  const gpt = config.scheduler.gpt
  let host = ''
  try {
    host = new URL(baseUrl).hostname
  } catch {
    host = ''
  }
  if (host === 'api.openai.com') {
    const buckets: SchedulerBucket[] = [
      {
        key: `openai:direct:model:${model}`,
        imagesPerMinute: gpt.directImagesPerMinute,
        coolDownOnRateLimit: true,
      },
      { key: 'openai:direct:inflight', concurrency: gpt.directConcurrency },
    ]
    if (gpt.directOrgImagesPerMinute > 0) {
      buckets.push({ key: 'openai:direct:org', imagesPerMinute: gpt.directOrgImagesPerMinute })
    }
    return buckets
  }
  if (gpt.sub2apiConcurrency > 0) {
    return [{ key: 'openai:sub2api:inflight', concurrency: gpt.sub2apiConcurrency }]
  }
  return []
}
