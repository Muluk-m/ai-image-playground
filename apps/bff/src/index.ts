import { config } from './config'
import { runMigrations } from './db/migrate'
import { purgeOldTasks, recoverInterruptedTasks } from './db/maintenance'
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
