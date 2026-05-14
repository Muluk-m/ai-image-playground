import { config } from './config'
import { runMigrations } from './db/migrate'
import { purgeOldTasks, recoverInterruptedTasks } from './db/maintenance'
import { inflightCount, inflightSnapshot } from './lib/inflight'
import { app } from './app'

runMigrations()

// 启动时收拾上次进程残留：queued 的重新跑 runTask（上游没动过，对用户无感），
// in_progress 的标 failed（上游可能已经发起 fetch，不能盲目重试）。没有这一段，
// BFF 重启后前端会傻乎乎 poll 那些孤儿到 30 min 超时。
const recovery = recoverInterruptedTasks()
if (recovery.retried > 0) {
  console.log(`[bff] retried ${recovery.retried} queued task(s)`)
}
if (recovery.failed > 0) {
  console.log(`[bff] marked ${recovery.failed} in-progress task(s) as failed`)
}

// 启动时清一次过期任务 + 每 6 小时跑一次。BFF 单实例，setInterval 不会重复。
const purgeStartup = purgeOldTasks()
if (purgeStartup > 0) console.log(`[bff] purged ${purgeStartup} task(s) older than 30 days`)
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000
setInterval(() => {
  const removed = purgeOldTasks()
  if (removed > 0) console.log(`[bff] purged ${removed} task(s) older than 30 days`)
}, PURGE_INTERVAL_MS)

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
 * 优雅关闭：launchctl kickstart -k 用 SIGTERM 然后到 ExitTimeOut（plist 设的 60s）
 * 才发 SIGKILL。收到 SIGTERM 后停 HTTP listener、等所有 inflight 的 runTask 跑完
 * 再退出，让正在生成图片的任务跑完写入 'completed'，新进程起来时就不留
 * in_progress 残留，用户感知到的是「部署完图就出来了」而不是「BFF 重启时中断」。
 *
 * 55s 硬上限给 launchd 留 5s 缓冲；超时强退，剩下的任务由下次启动 recovery
 * 兜底（仍走 in_progress → failed 路径）。注意：如果 plist 里没设 ExitTimeOut
 * （老版本部署的 LaunchAgent），launchd 默认 20s 就会 SIGKILL，drain 来不及。
 * 改 plist 后需要 reinstall LaunchAgent（unload + load）才生效。
 */
const SHUTDOWN_HARD_TIMEOUT_MS = 55_000
let shuttingDown = false

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[bff] ${signal} received, ${inflightCount()} task(s) in flight; draining...`)

  // 停 listener：现有连接继续 drain，不再接受新连接。
  try {
    await app.stop?.()
  } catch (err) {
    console.error('[bff] app.stop failed', err)
  }

  const hardTimer = setTimeout(() => {
    console.warn(
      `[bff] drain timeout (${SHUTDOWN_HARD_TIMEOUT_MS}ms) with ${inflightCount()} task(s) still running; forcing exit`,
    )
    process.exit(0)
  }, SHUTDOWN_HARD_TIMEOUT_MS)

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
