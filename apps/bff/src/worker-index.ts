import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { config } from './config'
import { close as closeDb } from './db/client'
import { recoverInterruptedTasks } from './db/maintenance'
import { isCapabilityEnabled } from './lib/capabilities'
import { initChannels } from './lib/channels'
import { log } from './lib/logger'
import { assertPrivateBffOverlayPresent, loadPrivateBffOverlay } from './lib/private-overlay'
import { abortRunningTasksForShutdown, runningTaskIds } from './workers/task-runner'
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

/**
 * 无主 in_progress 的兜底回收。SIGKILL 不给 drain 的机会，光靠启动扫一次只能覆盖
 * 「重启之后」的那一瞬间，所以启动扫一次之后还要按 STALE_SCAN_INTERVAL_MS 持续扫。
 */
async function recoverStaleTasks(): Promise<void> {
  const now = Date.now()
  await recoverInterruptedTasks(
    {
      startedBefore: now - QUEUE_TIMEOUTS.STALE_IN_PROGRESS_MS,
      excludeIds: runningTaskIds(),
    },
    now,
  )
}

await recoverStaleTasks()

const scheduler = new TaskScheduler()
scheduler.start()
const staleScanTimer = setInterval(() => {
  void recoverStaleTasks().catch((err) => {
    log.error(
      { event: 'worker.stale_scan_failed', err: err instanceof Error ? err.message : String(err) },
      'stale in-progress scan failed',
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
    const aborted = abortRunningTasksForShutdown()
    log.warn(
      { event: 'worker.shutdown_drain_timeout', drainTimeoutMs, aborted },
      'drain window expired, aborting inflight tasks for requeue',
    )
    if (!(await scheduler.waitForIdle(QUEUE_TIMEOUTS.SHUTDOWN_ABORT_SETTLE_MS))) {
      // runner 卡在 abort 后没能自己落盘，点名回收，别把行留在 in_progress。
      await recoverInterruptedTasks({ ids: runningTaskIds() })
    }
  }

  log.info({ event: 'worker.shutdown_done' }, 'task worker stopped')
  await finalize()
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => void gracefulShutdown('SIGINT'))
