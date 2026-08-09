import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { app } from './app'
import { config } from './config'
import { close as closeDb } from './db/client'
import { purgeOldTasks } from './db/maintenance'
import { initChannels } from './lib/channels'
import { log } from './lib/logger'
import { isCapabilityEnabled } from './lib/capabilities'

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
      accountsLoginEnabled,
    },
    'bff listening',
  )
})

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

  try {
    await app.stop?.()
  } catch (err) {
    log.error(
      { event: 'shutdown.stop_failed', err: err instanceof Error ? err.message : String(err) },
      'app.stop failed',
    )
  }

  log.info({ event: 'shutdown.done' }, 'bff stopped')
  await finalize()
}

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM')
})

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT')
})
