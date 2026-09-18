import { hostname } from 'node:os'
import { lt } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { appVersion } from './app-version'
import { log } from './logger'

/** 心跳间隔。看板与告警把「超过 2 分钟没心跳」当作服务断了，也就是容忍连续丢 3 次。 */
export const HEARTBEAT_INTERVAL_MS = 30_000
/** 重新部署会换容器、换实例名；旧实例的行留一天够排查，再久就只是噪音。 */
const STALE_HEARTBEAT_MS = 24 * 60 * 60 * 1000

export type HeartbeatService = 'bff' | 'worker'

export interface Heartbeat {
  service: HeartbeatService
  instance: string
  version: string
  detail?: Record<string, unknown>
  now: number
}

export { appVersion }

/** 每个实例一行，原地更新：心跳表回答的是「现在」，历史不归它管。 */
export async function writeHeartbeat(beat: Heartbeat): Promise<void> {
  const values = {
    service: beat.service,
    instance: beat.instance,
    version: beat.version,
    last_seen_at: beat.now,
    detail: beat.detail ?? null,
  }
  await db
    .insert(schema.service_heartbeats)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.service_heartbeats.service, schema.service_heartbeats.instance],
      set: { version: values.version, last_seen_at: values.last_seen_at, detail: values.detail },
    })
}

export async function purgeStaleHeartbeats(now: number = Date.now()): Promise<void> {
  await db
    .delete(schema.service_heartbeats)
    .where(lt(schema.service_heartbeats.last_seen_at, now - STALE_HEARTBEAT_MS))
}

interface StartHeartbeatOptions {
  service: HeartbeatService
  /** 每次心跳时现取的附加状态，例如 worker 最后一次成功轮询的时间。 */
  detail?: () => Record<string, unknown>
  intervalMs?: number
  write?: (beat: Heartbeat) => Promise<void>
  onError?: (error: unknown) => void
}

/**
 * 立刻跳一次，之后按间隔跳。写失败只记日志：监控自己出问题不该牵连请求与任务处理。
 * 返回的函数停止心跳，进程优雅退出时调用。
 */
export function startHeartbeat(options: StartHeartbeatOptions): () => void {
  const write = options.write ?? writeHeartbeat
  const onError =
    options.onError ??
    ((error: unknown) =>
      log.warn(
        {
          event: 'heartbeat.write_failed',
          service: options.service,
          err: error instanceof Error ? error.message : String(error),
        },
        'heartbeat write failed',
      ))
  const instance = hostname()
  let stopped = false
  const beat = (): void => {
    if (stopped) return
    write({
      service: options.service,
      instance,
      version: appVersion(),
      detail: options.detail?.(),
      now: Date.now(),
    }).catch(onError)
  }
  beat()
  const timer = setInterval(beat, options.intervalMs ?? HEARTBEAT_INTERVAL_MS)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
