import { QUEUE_TIMEOUTS, SERVER_IDLE_TIMEOUT_SEC } from '@image-playground/shared'
import { app } from './app'
import { config } from './config'
import { checkpointWal } from './db/client'
import { purgeOldOutputBlobs, purgeOldTasks } from './db/maintenance'
import { runMigrations } from './db/migrate'
import { initChannels } from './lib/channels'
import { log } from './lib/logger'

runMigrations()

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
const outputPurgeStartup = await purgeOldOutputBlobs()
if (outputPurgeStartup > 0) {
  log.info(
    { event: 'startup.output_blobs_purged', count: outputPurgeStartup },
    'purged expired output blobs',
  )
}
setInterval(async () => {
  const removed = await purgeOldTasks()
  if (removed > 0) log.info({ event: 'periodic.purged', count: removed }, 'purged old tasks')
  const removedOutputBlobs = await purgeOldOutputBlobs()
  if (removedOutputBlobs > 0) {
    log.info(
      { event: 'periodic.output_blobs_purged', count: removedOutputBlobs },
      'purged expired output blobs',
    )
  }
}, QUEUE_TIMEOUTS.PURGE_INTERVAL_MS)

if (config.corsOrigins === '*') {
  log.warn(
    { event: 'config.cors_wildcard' },
    'CORS_ALLOWED_ORIGINS=* — any origin can hit BFF and burn upstream quota; restrict in prod',
  )
}

app.listen({ port: config.port, idleTimeout: SERVER_IDLE_TIMEOUT_SEC }, () => {
  log.info(
    {
      event: 'listen',
      port: config.port,
      upstream: config.upstream.baseUrl,
      corsOrigins: config.corsOrigins,
      staticDir: config.staticDir,
    },
    'bff listening',
  )
})

let shuttingDown = false

function finalize(exitCode = 0): never {
  checkpointWal()
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
  finalize()
}

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM')
})

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT')
})
