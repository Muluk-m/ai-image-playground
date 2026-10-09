import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { config } from './config'
import { close as closeDb } from './db/client'
import { purgeOldHostSamples, recoverAbandonedTasks, recoverTasksByIds } from './db/maintenance'
import { recoverAnalysisTasks } from './lib/analysis-tasks'
import { isCapabilityEnabled } from './lib/capabilities'
import { initChannels } from './lib/channels'
import { purgeStaleHeartbeats, startHeartbeat } from './lib/heartbeat'
import { log } from './lib/logger'
import { assertPrivateBffOverlayPresent, loadPrivateBffOverlay } from './lib/private-overlay'
import { startServerLogs } from './lib/server-logs'
import { createAlertSender } from './ops/alert-sender'
import { createAppAlerting } from './ops/app-alerts'
import { abortAllRunningAnalysisTasks, runningAnalysisTaskIds } from './workers/analysis-runner'
import { abortAllRunningTasks, runningTaskIds } from './workers/task-execution'
import { TaskScheduler } from './workers/task-scheduler'
import { startWorkerHealthServer } from './workers/worker-health'

const stopServerLogs = startServerLogs()
config.assertValid()
const channelsResult = initChannels(config.channelsFile ?? undefined)
for (const warning of channelsResult.warnings) {
  log.warn({ event: 'channels.warning' }, warning)
}

if (isCapabilityEnabled('billing:credits')) {
  assertPrivateBffOverlayPresent(await loadPrivateBffOverlay(), 'billing:credits')
}

// 启动扫一次只覆盖「重启之后」那一瞬间，SIGKILL 随时可能再留下无主行，所以要持续扫。
if (!config.worker.startPaused) {
  await recoverAbandonedTasks()
  await recoverAnalysisTasks()
}

const scheduler = new TaskScheduler()
if (config.worker.startPaused) scheduler.drain()
scheduler.start()
const activationTimer =
  config.worker.startPaused && config.worker.activationFile
    ? setInterval(() => {
        if (!config.worker.startPaused) {
          scheduler.resume()
          clearInterval(activationTimer!)
        }
      }, 1000)
    : undefined
// 活着不等于在干活：把最后一次成功轮询的时间一并写进心跳，看板才分得清两者。
const stopHeartbeat = startHeartbeat({
  service: 'worker',
  detail: () => ({
    last_successful_poll_at: scheduler.lastSuccessfulPollAt(),
    alerts_configured: Boolean(process.env.OPS_ALERT_WEBHOOK_URL?.trim()),
  }),
})
// 队列积压、备份断了、后端心跳断了：每次维护循环看一眼，该发就发。没配地址就安静跳过。
const checkAppAlerts = createAppAlerting({
  send: createAlertSender({
    webhookUrl: process.env.OPS_ALERT_WEBHOOK_URL,
    deployment: process.env.OPS_DEPLOYMENT_NAME?.trim() || 'deployment',
  }),
})
let privateMaintenance: Promise<void> | undefined
const staleScanTimer = setInterval(() => {
  if (!scheduler.drainStatus().draining && !privateMaintenance) {
    privateMaintenance = loadPrivateBffOverlay()
      .then((overlay) => overlay.taskHooks.runWorkerMaintenance?.(Date.now()))
      .catch((err) =>
        log.warn({ event: 'worker.private_maintenance_failed', err }, 'private maintenance failed'),
      )
      .finally(() => {
        privateMaintenance = undefined
      })
  }
  void checkAppAlerts()
  // 运维看板的两张小表都靠这个循环保持小：过期的心跳实例，和 7 天前的宿主机采样。
  Promise.all([purgeStaleHeartbeats(), purgeOldHostSamples()]).catch((err) => {
    log.warn(
      { event: 'worker.ops_purge_failed', err: err instanceof Error ? err.message : String(err) },
      'operations board table purge failed',
    )
  })
  if (!scheduler.drainStatus().draining)
    Promise.all([recoverAbandonedTasks(runningTaskIds()), recoverAnalysisTasks()]).catch((err) => {
      log.error(
        {
          event: 'worker.stale_scan_failed',
          err: err instanceof Error ? err.message : String(err),
        },
        'abandoned in-progress scan failed',
      )
    })
}, 15_000)
const workerHealthServer = startWorkerHealthServer({
  port: config.worker.healthPort,
  drain: () => scheduler.drain(),
  resume: () => scheduler.resume(),
  drainStatus: () => scheduler.drainStatus(),
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
  await stopServerLogs()
  await closeDb()
  log.flush()
  process.exit(exitCode)
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  scheduler.stop()
  if (activationTimer) clearInterval(activationTimer)
  stopHeartbeat()
  clearInterval(staleScanTimer)
  await workerHealthServer.stop()
  const drainTimeoutMs = config.worker.drainTimeoutMs
  log.info(
    { event: 'worker.shutdown_start', signal, inflight: scheduler.activeCount(), drainTimeoutMs },
    'stopping task worker',
  )

  let maintenanceTimeout: ReturnType<typeof setTimeout> | undefined
  const [idle] = await Promise.all([
    scheduler.waitForIdle(drainTimeoutMs),
    Promise.race([
      privateMaintenance,
      new Promise<void>((resolve) => {
        maintenanceTimeout = setTimeout(resolve, drainTimeoutMs)
      }),
    ]).finally(() => clearTimeout(maintenanceTimeout)),
  ])
  if (!idle) {
    // id 必须在 abort 之前取：runner settle 之后会把自己从 runningTasks 摘掉。
    const aborted = runningTaskIds()
    const abortedAnalysis = runningAnalysisTaskIds()
    abortAllRunningTasks()
    abortAllRunningAnalysisTasks()
    log.warn(
      { event: 'worker.shutdown_drain_timeout', drainTimeoutMs, aborted: aborted.length },
      'drain window expired, aborting inflight tasks for requeue',
    )
    await scheduler.waitForIdle(QUEUE_TIMEOUTS.SHUTDOWN_ABORT_SETTLE_MS)
    await recoverTasksByIds(aborted)
    await recoverAnalysisTasks(Date.now(), abortedAnalysis)
  }

  log.info({ event: 'worker.shutdown_done' }, 'task worker stopped')
  await finalize()
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => void gracefulShutdown('SIGINT'))
