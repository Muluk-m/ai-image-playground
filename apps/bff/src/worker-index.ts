import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { config } from './config'
import { close as closeDb } from './db/client'
import { recoverInterruptedTasks } from './db/maintenance'
import { isCapabilityEnabled } from './lib/capabilities'
import { initChannels } from './lib/channels'
import { log } from './lib/logger'
import { assertPrivateBffOverlayPresent, loadPrivateBffOverlay } from './lib/private-overlay'
import { abortAllRunningTasks } from './workers/task-runner'
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

const recovery = await recoverInterruptedTasks()
if (recovery.failed > 0) {
  log.info(
    { event: 'worker.startup_failed_interrupted', count: recovery.failed },
    'marked stale in-progress tasks as failed',
  )
}

const scheduler = new TaskScheduler()
scheduler.start()
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
  await workerHealthServer.stop()
  log.info(
    { event: 'worker.shutdown_start', signal, inflight: scheduler.activeCount() },
    'stopping task worker',
  )

  const aborted = abortAllRunningTasks()
  if (aborted > 0) {
    log.info({ event: 'worker.shutdown_aborted', count: aborted }, 'aborted running tasks')
  }

  const hardTimer = setTimeout(() => {
    log.warn(
      {
        event: 'worker.shutdown_timeout',
        timeoutMs: QUEUE_TIMEOUTS.SHUTDOWN_HARD_TIMEOUT_MS,
        inflight: scheduler.activeCount(),
      },
      'worker drain timeout, forcing exit',
    )
    void finalize()
  }, QUEUE_TIMEOUTS.SHUTDOWN_HARD_TIMEOUT_MS)

  await scheduler.waitForIdle()
  await recoverInterruptedTasks()
  clearTimeout(hardTimer)
  log.info({ event: 'worker.shutdown_done' }, 'task worker stopped')
  await finalize()
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => void gracefulShutdown('SIGINT'))
