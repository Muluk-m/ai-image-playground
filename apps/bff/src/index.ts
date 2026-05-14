import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { config } from './config'
import { runMigrations } from './db/migrate'
import { purgeOldTasks, recoverInterruptedTasks } from './db/maintenance'
import { inflightCount, inflightSnapshot } from './lib/inflight'
import { app } from './app'

runMigrations()

// 启动时收拾上次进程残留：queued 的重新跑 runTask（上游没动过，对用户无感），
// in_progress 的标 failed（上游可能已经发起 fetch，不能盲目重试）。没有这一段，
// BFF 重启后前端会傻乎乎 poll 那些孤儿到 30 min 超时。
const recovery = await recoverInterruptedTasks()
if (recovery.retried > 0) console.log(`[bff] retried ${recovery.retried} queued task(s)`)
if (recovery.failed > 0) console.log(`[bff] marked ${recovery.failed} in-progress task(s) as failed`)

// 启动时清一次过期任务 + 定时再跑（间隔见 QUEUE_TIMEOUTS.PURGE_INTERVAL_MS）。
// BFF 单实例，setInterval 不会重复。
const purgeStartup = await purgeOldTasks()
if (purgeStartup > 0) console.log(`[bff] purged ${purgeStartup} task(s) older than 30 days`)
setInterval(async () => {
  const removed = await purgeOldTasks()
  if (removed > 0) console.log(`[bff] purged ${removed} task(s) older than 30 days`)
}, QUEUE_TIMEOUTS.PURGE_INTERVAL_MS)

if (config.corsOrigins === '*') {
  console.warn(
    '[bff] ⚠️  CORS_ALLOWED_ORIGINS=*：任何 origin 的浏览器都能调本 BFF + 消耗 sub2api 配额。' +
      '生产应限制为前端实际 origin（如 https://image-playground.qiliangjia.one）。',
  )
}

app.listen(config.port, () => {
  console.log(`[bff] listening on http://localhost:${config.port}`)
  console.log(`[bff] upstream sub2api: ${config.sub2api.baseUrl}`)
  console.log(`[bff] cors origins: ${config.corsOrigins}`)
  if (config.staticDir) console.log(`[bff] serving static files from: ${config.staticDir}`)
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
  console.log(`[bff] ${signal} received, ${inflightCount()} task(s) in flight; draining...`)

  try {
    await app.stop?.()
  } catch (err) {
    console.error('[bff] app.stop failed', err)
  }

  const hardTimer = setTimeout(() => {
    console.warn(
      `[bff] drain timeout (${QUEUE_TIMEOUTS.SHUTDOWN_HARD_TIMEOUT_MS}ms) with ${inflightCount()} task(s) still running; forcing exit`,
    )
    process.exit(0)
  }, QUEUE_TIMEOUTS.SHUTDOWN_HARD_TIMEOUT_MS)

  // 周期性打个进度日志，让运维知道还在等什么。
  const progressTimer = setInterval(() => {
    const remaining = inflightCount()
    if (remaining > 0) console.log(`[bff] still draining, ${remaining} task(s) left`)
  }, 5_000)

  // 快照锁定当前的 inflight；allSettled 永不 reject，即使个别 task 抛错也不影响 drain。
  await Promise.allSettled(inflightSnapshot())

  clearTimeout(hardTimer)
  clearInterval(progressTimer)
  console.log('[bff] all tasks drained, exiting cleanly')
  process.exit(0)
}

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM')
})
