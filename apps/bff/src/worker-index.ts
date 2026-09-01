import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { config } from './config'
import { close as closeDb } from './db/client'
import { recoverAbandonedTasks, recoverTasksByIds } from './db/maintenance'
import { isCapabilityEnabled } from './lib/capabilities'
import { initChannels } from './lib/channels'
import { log } from './lib/logger'
import { assertPrivateBffOverlayPresent, loadPrivateBffOverlay } from './lib/private-overlay'
import { abortAllRunningTasks, runningTaskIds } from './workers/task-runner'
import { TaskScheduler } from './workers/task-scheduler'
import { startWorkerHealthServer } from './workers/worker-health'

config.assertValid()
const channelsResult = initChannels(config.channelsFile ?? undefined)
for (const warning of channelsResult.warnings) {
  log.warn({ event: 'channels.warning' }, warning)
}

if (isCapabilityEnabled('billing:credits')) {
  assertPrivateBffOverlayPresent(await loadPrivateBffOverlay(), 'billing:credits')
}

// 启动扫一次只覆盖「重启之后」那一瞬间，SIGKILL 随时可能再留下无主行，所以要持续扫。
await recoverAbandonedTasks()

const scheduler = new TaskScheduler()
scheduler.start()
const staleScanTimer = setInterval(() => {
  recoverAbandonedTasks(runningTaskIds()).catch((err) => {
    log.error(
      { event: 'worker.stale_scan_failed', err: err instanceof Error ? err.message : String(err) },
      'abandoned in-progress scan failed',
    )
  })
}, QUEUE_TIMEOUTS.STALE_SCAN_INTERVAL_MS)
const workerHealthServer = startWorkerHealthServer({
  port: config.worker.healthPort,
  staleAfterMs: config.worker.healthStaleAfterMs,
  lastSuccessfulPollAt: () => scheduler.lastSuccessfulPollAt(),
})
log.info(
  {
    event: 'worker.started',
    pollIntervalMs: config.worker.pollIntervalMs,
    healthPort: config.worker.healthPort,
    healthStaleAfterMs: config.worker.healthStaleAfterMs,
    openaiConcurrency: config.worker.concurrency.openaiCompat,
    geminiConcurrency: config.worker.concurrency.gemini,
  },
  'task worker started',
)

let shuttingDown = false

async function finalize(exitCode = 0): Promise<never> {
  await closeDb()
  log.flush()
  process.exit(exitCode)
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  scheduler.stop()
  clearInterval(staleScanTimer)
  await workerHealthServer.stop()
  const drainTimeoutMs = config.worker.drainTimeoutMs
  log.info(
    { event: 'worker.shutdown_start', signal, inflight: scheduler.activeCount(), drainTimeoutMs },
    'stopping task worker',
  )

  if (!(await scheduler.waitForIdle(drainTimeoutMs))) {
    // id 必须在 abort 之前取：runner settle 之后会把自己从 runningTasks 摘掉。
    const aborted = runningTaskIds()
    abortAllRunningTasks()
    log.warn(
      { event: 'worker.shutdown_drain_timeout', drainTimeoutMs, aborted: aborted.length },
      'drain window expired, aborting inflight tasks for requeue',
    )
    await scheduler.waitForIdle(QUEUE_TIMEOUTS.SHUTDOWN_ABORT_SETTLE_MS)
    await recoverTasksByIds(aborted)
  }

  log.info({ event: 'worker.shutdown_done' }, 'task worker stopped')
  await finalize()
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => void gracefulShutdown('SIGINT'))
