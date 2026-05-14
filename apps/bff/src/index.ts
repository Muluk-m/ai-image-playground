import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { app } from './app'
import { config } from './config'
import { checkpointWal } from './db/client'
import { purgeOldTasks, recoverInterruptedTasks } from './db/maintenance'
import { runMigrations } from './db/migrate'
import { inflightCount, inflightSnapshot } from './lib/inflight'
import { log } from './lib/logger'

runMigrations()

// 启动时收拾上次进程残留：queued 的重新跑 runTask（上游没动过，对用户无感），
// in_progress 的标 failed（上游可能已经发起 fetch，不能盲目重试）。没有这一段，
// BFF 重启后前端会傻乎乎 poll 那些孤儿到 30 min 超时。
const recovery = await recoverInterruptedTasks()
if (recovery.retried > 0) log.info({ event: 'startup.retried', count: recovery.retried }, 'retried queued tasks')
if (recovery.failed > 0) log.info({ event: 'startup.failed_interrupted', count: recovery.failed }, 'marked in-progress as failed')

const purgeStartup = await purgeOldTasks()
if (purgeStartup > 0) log.info({ event: 'startup.purged', count: purgeStartup }, 'purged old tasks')
setInterval(async () => {
  const removed = await purgeOldTasks()
  if (removed > 0) log.info({ event: 'periodic.purged', count: removed }, 'purged old tasks')
}, QUEUE_TIMEOUTS.PURGE_INTERVAL_MS)

if (config.corsOrigins === '*') {
  log.warn(
    { event: 'config.cors_wildcard' },
    'CORS_ALLOWED_ORIGINS=* — any origin can hit BFF and burn sub2api quota; restrict in prod',
  )
}

app.listen(config.port, () => {
  log.info(
    {
      event: 'listen',
      port: config.port,
      upstream: config.sub2api.baseUrl,
      corsOrigins: config.corsOrigins,
      staticDir: config.staticDir,
    },
    'bff listening',
  )
})

/**
 * SIGTERM 优雅关闭：launchctl kickstart -k 先 SIGTERM 再等 ExitTimeOut（plist 设的 60s）
 * 才 SIGKILL。让在跑的 task 跑完写 'completed'，新进程起来时不留 in_progress 残留。
 * 老版本 plist 未设 ExitTimeOut 时 launchd 默认 20s 即 SIGKILL，需 reinstall LaunchAgent 才生效。
 */
let shuttingDown = false

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ event: 'shutdown.start', signal, inflight: inflightCount() }, 'draining')

  try {
    await app.stop?.()
  } catch (err) {
    log.error({ event: 'shutdown.stop_failed', err: err instanceof Error ? err.message : String(err) }, 'app.stop failed')
  }

  const hardTimer = setTimeout(() => {
    log.warn(
      { event: 'shutdown.timeout', timeoutMs: QUEUE_TIMEOUTS.SHUTDOWN_HARD_TIMEOUT_MS, inflight: inflightCount() },
      'drain timeout, forcing exit',
    )
    checkpointWal()
    process.exit(0)
  }, QUEUE_TIMEOUTS.SHUTDOWN_HARD_TIMEOUT_MS)

  const progressTimer = setInterval(() => {
    const remaining = inflightCount()
    if (remaining > 0) log.info({ event: 'shutdown.progress', inflight: remaining }, 'still draining')
  }, 5_000)

  await Promise.allSettled(inflightSnapshot())

  clearTimeout(hardTimer)
  clearInterval(progressTimer)
  checkpointWal()
  log.info({ event: 'shutdown.done' }, 'all tasks drained, exiting cleanly')
  process.exit(0)
}

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM')
})
