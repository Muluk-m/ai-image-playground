import { QUEUE_TIMEOUTS, SERVER_IDLE_TIMEOUT_SEC } from '@image-playground/shared'
import { config } from './config'
import { close as closeDb, db, schema } from './db/client'
import { purgeOldTasks, purgeOrphanedAssetObjects, runPrivateMaintenance } from './db/maintenance'
import { purgeOldAgentTurnEvents } from './lib/agent/events'
import { isCapabilityEnabled } from './lib/capabilities'
import { initChannels } from './lib/channels'
import { bffDrain } from './lib/drain'
import { purgeStaleHeartbeats, startHeartbeat } from './lib/heartbeat'
import { log } from './lib/logger'
import { runPeriodicSteps, startPeriodicSteps } from './lib/periodic'
import { withRequestContext } from './lib/request-context'

// 与 Cloudflare 的请求体上限对齐：生产流量经它进来，超过的本来就到不了这里；直连源站时
// 也不该放进更大的。前端提交前会把参考图压到长边 2048，正常一次远小于这个数。
const MAX_REQUEST_BODY_SIZE_BYTES = 100 * 1024 * 1024

config.assertValid()
log.info(
  {
    event: 'capabilities.resolved',
    file: config.operator.file,
    loaded: config.operator.loaded,
    capabilities: Object.fromEntries(
      Object.entries(config.operator.capabilities).map(([key, value]) => [
        key,
        {
          value,
          source:
            config.operator.capabilitySources[key as keyof typeof config.operator.capabilities],
        },
      ]),
    ),
    quotas: Object.fromEntries(
      Object.entries(config.operator.quotas).map(([key, value]) => [
        key,
        {
          value,
          source: config.operator.quotaSources[key as keyof typeof config.operator.quotas],
        },
      ]),
    ),
  },
  'operator capabilities resolved',
)
const accountsLoginEnabled = isCapabilityEnabled('accounts:login')
const syncEnabled = isCapabilityEnabled('accounts:sync')
const agentEnabled = isCapabilityEnabled('agent:chat')

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

// 技能目录读一次就缓存。放在启动而不是第一轮：镜像漏打 `apps/bff/skills` 时，
// loader 只会静默跳过缺席目录，起跑时的这条日志是唯一看得见的信号。
if (agentEnabled) {
  // 动态引入：`skills` 静态依赖 pi，`agent:chat` 关着的部署不该在启动时付那 60-90ms。
  const { ensureAgentSkills } = await import('./lib/agent/skills')
  const skills = await ensureAgentSkills()
  log.info(
    { event: 'agent.skills_ready', image: skills.image.length, video: skills.video.length },
    'agent skills ready',
  )
}

// Importing the app loads optional private routes. Public migrations and
// channel discovery must be ready before that overlay initializes.
const { app, apiMetrics } = await import('./app')

// 开机清理失败（例如积压太多撞上语句超时）只记一条，不拦着启动：定时清理会接着清。
await runPeriodicSteps([
  { event: 'startup.private_maintenance_failed', run: runPrivateMaintenance },
  {
    event: 'startup.purge_tasks_failed',
    run: async () => {
      const removed = await purgeOldTasks()
      if (removed > 0) log.info({ event: 'startup.purged', count: removed }, 'purged old tasks')
    },
  },
])
startPeriodicSteps(QUEUE_TIMEOUTS.PURGE_INTERVAL_MS, [
  {
    event: 'periodic.purge_tasks_failed',
    run: async () => {
      const removed = await purgeOldTasks()
      if (removed > 0) log.info({ event: 'periodic.purged', count: removed }, 'purged old tasks')
    },
  },
  { event: 'periodic.private_maintenance_failed', run: runPrivateMaintenance },
  // worker 的维护循环也清；没有 worker 的部署只有这里清。
  { event: 'periodic.purge_heartbeats_failed', run: () => purgeStaleHeartbeats() },
  ...(syncEnabled
    ? [
        {
          event: 'periodic.purge_asset_owners_failed',
          run: async () => {
            const orphaned = await purgeOrphanedAssetObjects()
            if (orphaned > 0) {
              log.info(
                { event: 'periodic.purged_asset_owners', count: orphaned },
                'purged asset objects',
              )
            }
          },
        },
      ]
    : []),
  ...(agentEnabled
    ? [
        {
          event: 'periodic.purge_agent_events_failed',
          run: async () => {
            const expired = await purgeOldAgentTurnEvents()
            if (expired > 0) {
              log.info(
                { event: 'periodic.purged_agent_events', count: expired },
                'purged agent events',
              )
            }
          },
        },
      ]
    : []),
])

if (config.corsOrigins === '*') {
  log.warn(
    { event: 'config.cors_wildcard' },
    'CORS_ALLOWED_ORIGINS=* — any origin can hit BFF and burn upstream quota; restrict in prod',
  )
}

// 不用 app.listen：每个请求要先套上 request id 的上下文，日志才能按请求串起来。
// 代价是 Elysia 的 onStart / onStop 钩子与 `.use(import(...))` 懒加载路由不再生效，别往这上面加。
const server = Bun.serve({
  port: config.port,
  // app.listen 原本替我们关掉的开发模式：开着时未捕获的错误会回带调用栈的错误页。
  development: false,
  idleTimeout: SERVER_IDLE_TIMEOUT_SEC,
  maxRequestBodySize: MAX_REQUEST_BODY_SIZE_BYTES,
  fetch: withRequestContext((request) => app.fetch(request)),
})
// 路由靠 context.server 取对端地址（requestIP）做限流，自己起的 server 要交给 Elysia。
app.server = server
log.info(
  {
    event: 'listen',
    port: server.port,
    upstream: config.upstream.baseUrl,
    corsOrigins: config.corsOrigins,
    staticDir: config.staticDir,
    accountsLoginEnabled,
  },
  'bff listening',
)

// 运维看板靠心跳判断后端死活与线上版本；写失败只记日志，不影响请求处理。
const stopHeartbeat = startHeartbeat({ service: 'bff' })

// 排队消息与唤醒的兜底：收尾那个实例正在下线或半路没了时由这里接着开轮；worker 写进收件箱的
// 唤醒、等太久先唤醒的那一批也由这里起轮。开机先巡一次。
const stopInboxPickup = agentEnabled
  ? (await import('./lib/agent/inbox-pickup')).startInboxPickup()
  : () => {}

// 重试队列的推进：前一条重试的任务结束时没有请求在场，由这里按先后提交下一条。开机先扫一遍。
const stopRetryPickup = agentEnabled
  ? (await import('./lib/agent/retry')).startRetryQueuePickup()
  : () => {}

// 接口统计：每分钟把已经结束的那几分钟写成行。写失败的那一分钟就丢了，不重试——
// 它只是看板上的一个点，不值得为它把内存攒大。
async function flushApiMinutes(all = false): Promise<void> {
  const rows = apiMetrics.drain(Date.now(), all)
  if (rows.length === 0) return
  try {
    await db.insert(schema.api_minutes).values(rows).onConflictDoNothing()
  } catch (err) {
    log.warn(
      { event: 'ops.api_minutes_failed', err: err instanceof Error ? err.message : String(err) },
      'could not store API statistics',
    )
  }
}
const apiMinutesTimer = setInterval(() => void flushApiMinutes(), 60_000)

let shuttingDown = false

async function finalize(exitCode = 0): Promise<never> {
  await closeDb()
  // pino async transport：log.flush() 同步刷盘，防 process.exit 吞最后几行。
  log.flush()
  process.exit(exitCode)
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log.info({ event: 'shutdown.start', signal }, 'stopping bff')
  bffDrain.begin()
  stopInboxPickup()
  stopRetryPickup()
  while (!bffDrain.status().safeToStop) await Bun.sleep(250)
  stopHeartbeat()
  clearInterval(apiMinutesTimer)

  try {
    await server.stop()
  } catch (err) {
    log.error(
      { event: 'shutdown.stop_failed', err: err instanceof Error ? err.message : String(err) },
      'server.stop failed',
    )
  }

  await flushApiMinutes(true)
  log.info({ event: 'shutdown.done' }, 'bff stopped')
  await finalize()
}

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM')
})

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT')
})
