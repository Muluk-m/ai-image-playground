import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { app } from './app'
import { config } from './config'
import { checkpointWal } from './db/client'
import { purgeOldTasks, recoverInterruptedTasks } from './db/maintenance'
import { runMigrations } from './db/migrate'
import { initChannels } from './lib/channels'
import { inflightCount, inflightSnapshot } from './lib/inflight'
import { log } from './lib/logger'
import { abortAllRunningTasks } from './workers/task-runner'

runMigrations()

const channelsResult = initChannels(config.channelsFile ?? undefined)
for (const warning of channelsResult.warnings) {
  log.warn({ event: 'channels.warning' }, warning)
}
log.info(
  { event: 'channels.loaded', count: channelsResult.channels.length },
  channelsResult.channels.length > 0
    ? `loaded ${channelsResult.channels.length} channel(s)`
    : 'no channels loaded (BYOK-only deployment)',
)

// 启动时收拾上次进程残留：queued 的重新跑 runTask（上游没动过，对用户无感），
// in_progress 的标 failed（上游可能已经发起 fetch，不能盲目重试）。没有这一段，
// BFF 重启后前端会傻乎乎 poll 那些孤儿到 30 min 超时。
const recovery = await recoverInterruptedTasks()
if (recovery.retried > 0)
  log.info({ event: 'startup.retried', count: recovery.retried }, 'retried queued tasks')
if (recovery.failed > 0)
  log.info(
    { event: 'startup.failed_interrupted', count: recovery.failed },
    'marked in-progress as failed',
  )

const purgeStartup = await purgeOldTasks()
if (purgeStartup > 0) log.info({ event: 'startup.purged', count: purgeStartup }, 'purged old tasks')
setInterval(async () => {
  const removed = await purgeOldTasks()
  if (removed > 0) log.info({ event: 'periodic.purged', count: removed }, 'purged old tasks')
}, QUEUE_TIMEOUTS.PURGE_INTERVAL_MS)

if (config.corsOrigins === '*') {
  log.warn(
    { event: 'config.cors_wildcard' },
    'CORS_ALLOWED_ORIGINS=* — any origin can hit BFF and burn upstream quota; restrict in prod',
  )
}

app.listen(config.port, () => {
  log.info(
    {
      event: 'listen',
      port: config.port,
      upstream: config.upstream.baseUrl,
      corsOrigins: config.corsOrigins,
      staticDir: config.staticDir,
    },
    'bff listening',
  )
})

/**
 * SIGTERM 优雅关闭：让在跑的 task 跑完写 'completed'，新进程起来时不留 in_progress 残留。
 * 进程管理器需要给至少 SHUTDOWN_HARD_TIMEOUT_MS (55s) + 缓冲的优雅退出时间，否则
 * inflight 上游 fetch 会被 SIGKILL 中断（任务在 sqlite 里挂成 interrupted）。
 */
let shuttingDown = false

function finalize(exitCode = 0): never {
  checkpointWal()
  // pino async transport：log.flush() 同步刷盘，防 process.exit 吞最后几行。
  log.flush()
  process.exit(exitCode)
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ event: 'shutdown.start', signal, inflight: inflightCount() }, 'draining')

  try {
    await app.stop?.()
  } catch (err) {
    log.error(
      { event: 'shutdown.stop_failed', err: err instanceof Error ? err.message : String(err) },
      'app.stop failed',
    )
  }

  // SIGTERM 真打断进行中 task：让上游 fetch 立刻 abort（worker AbortError 分支
  // silent return；row 留在 in_progress 给下次启动 recovery 标 failed）。这样
  // 短任务自然跑完 + 长任务不再让部署 stall 满 55s drain 窗口。
  const aborted = abortAllRunningTasks()
  if (aborted > 0) log.info({ event: 'shutdown.aborted', count: aborted }, 'aborted running tasks')

  const hardTimer = setTimeout(() => {
    log.warn(
      {
        event: 'shutdown.timeout',
        timeoutMs: QUEUE_TIMEOUTS.SHUTDOWN_HARD_TIMEOUT_MS,
        inflight: inflightCount(),
      },
      'drain timeout, forcing exit',
    )
    finalize()
  }, QUEUE_TIMEOUTS.SHUTDOWN_HARD_TIMEOUT_MS)

  const progressTimer = setInterval(() => {
    const remaining = inflightCount()
    if (remaining > 0)
      log.info({ event: 'shutdown.progress', inflight: remaining }, 'still draining')
  }, 5_000)

  await Promise.allSettled(inflightSnapshot())

  clearTimeout(hardTimer)
  clearInterval(progressTimer)
  log.info({ event: 'shutdown.done' }, 'all tasks drained, exiting cleanly')
  finalize()
}

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM')
})
