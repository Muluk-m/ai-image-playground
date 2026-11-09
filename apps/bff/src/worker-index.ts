import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { config } from './config'
import { close as closeDb } from './db/client'
import { purgeOldHostSamples, recoverAbandonedTasks, recoverTasksByIds } from './db/maintenance'
import { recoverAnalysisTasks } from './lib/analysis-tasks'
import { autoReconcileTasks } from './lib/auto-reconcile'
import { isCapabilityEnabled } from './lib/capabilities'
import { initChannels, refreshChannelsIfChanged } from './lib/channels'
import { purgeStaleHeartbeats, startHeartbeat } from './lib/heartbeat'
import { log } from './lib/logger'
import {
  refreshOperatorConfig,
  refreshOperatorConfigIfChanged,
} from './lib/operator-config-overrides'
import { assertPrivateBffOverlayPresent, loadPrivateBffOverlay } from './lib/private-overlay'
import { startServerLogs } from './lib/server-logs'
import { startSharedMaintenance } from './lib/shared-maintenance'
import { refreshUpstreamKeySources } from './lib/upstream/gpt-direct-admin'
import { logFingerprintMacSourceOnce } from './lib/upstream/gpt-key-config'
import { UPSTREAM_SECRET_REFRESH_MS } from './lib/upstream-secrets'
import { registerAppAlertScan } from './ops/alert-kick'
import { alertTargetsConfigured, createAlertSenderFromEnv } from './ops/alert-sender'
import { createAppAlerting } from './ops/app-alerts'
import { abortAllRunningAnalysisTasks, runningAnalysisTaskIds } from './workers/analysis-runner'
import { abortAllRunningTasks, runningTaskIds } from './workers/task-execution'
import { TaskScheduler } from './workers/task-scheduler'
import { startWorkerHealthServer } from './workers/worker-health'

const stopServerLogs = startServerLogs()
config.assertValid()
logFingerprintMacSourceOnce()
await refreshUpstreamKeySources().catch((error) =>
  log.error(
    {
      event: 'upstream_secrets.startup_refresh_failed',
      err: error instanceof Error ? error.message : 'unknown',
    },
    'upstream secret refresh failed',
  ),
)
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
await refreshOperatorConfig().catch((error) =>
  log.error(
    { event: 'operator_config.startup_refresh_failed', error },
    'operator config refresh failed',
  ),
)
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
    alerts_configured: alertTargetsConfigured(),
  }),
})
// 队列积压、备份断了、后端心跳断了：每次维护循环看一眼，该发就发。没配地址就安静跳过。
const checkAppAlerts = createAppAlerting({
  send: createAlertSenderFromEnv({
    deployment: process.env.OPS_DEPLOYMENT_NAME?.trim() || 'deployment',
    onPartialFailure: (error) =>
      log.warn({ event: 'ops.alert_target_failed', err: error.message }, 'an alert target failed'),
  }),
})
registerAppAlertScan(checkAppAlerts)
let privateMaintenance: Promise<void> | undefined
let operatorConfigRefresh: Promise<unknown> | undefined
const stopOpsMaintenance = startSharedMaintenance({
  job: 'operations-history',
  work: async (transaction) => {
    const now = Date.now()
    await purgeStaleHeartbeats(now, transaction)
    await purgeOldHostSamples(now, transaction)
  },
  onError: (err) => {
    log.warn(
      { event: 'worker.ops_purge_failed', err: err instanceof Error ? err.message : String(err) },
      'operations board table purge failed',
    )
  },
})
const staleScanTimer = setInterval(() => {
  if (!operatorConfigRefresh) {
    operatorConfigRefresh = refreshOperatorConfigIfChanged()
      .catch((error) =>
        log.error(
          { event: 'operator_config.periodic_refresh_failed', error },
          'operator config refresh failed',
        ),
      )
      .finally(() => {
        operatorConfigRefresh = undefined
      })
  }
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
  if (!scheduler.drainStatus().draining)
    Promise.all([
      recoverAbandonedTasks(runningTaskIds()),
      recoverAnalysisTasks(),
      autoReconcileTasks(),
    ]).catch((err) => {
      log.error(
        {
          event: 'worker.stale_scan_failed',
          err: err instanceof Error ? err.message : String(err),
        },
        'abandoned in-progress scan failed',
      )
    })
}, 10_000)
let upstreamRefreshRunning = false
const upstreamSecretTimer = setInterval(() => {
  if (upstreamRefreshRunning) return
  upstreamRefreshRunning = true
  // 刷新失败只记日志，渠道清单照样重建（否则一次读库失败会让这个定时器每轮都白跑）。
  void refreshUpstreamKeySources()
    .catch((error) =>
      log.error(
        {
          event: 'upstream_secrets.periodic_refresh_failed',
          err: error instanceof Error ? error.message : 'unknown',
        },
        'upstream secret refresh failed',
      ),
    )
    .then(() => refreshChannelsIfChanged(config.channelsFile ?? undefined))
    .catch((error) =>
      log.error(
        {
          event: 'channels.periodic_refresh_failed',
          err: error instanceof Error ? error.message : 'unknown',
        },
        'channels refresh failed',
      ),
    )
    .finally(() => {
      upstreamRefreshRunning = false
    })
}, UPSTREAM_SECRET_REFRESH_MS)
const workerHealthServer = startWorkerHealthServer({
  port: config.worker.healthPort,
  drain: () => scheduler.drain(),
  resume: () => scheduler.resume(),
  drainStatus: () => {
    const status = scheduler.drainStatus()
    return {
      ...status,
      maintenanceActive: privateMaintenance !== undefined,
      safeToStop: status.safeToStop && privateMaintenance === undefined,
    }
  },
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
  clearInterval(upstreamSecretTimer)
  const opsMaintenanceStopped = stopOpsMaintenance()
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
    opsMaintenanceStopped,
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
