import { createReporter, readHostSample, runCollector } from './ops/host-collector'

function say(level: 'info' | 'warn', event: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, service: 'host-collector', event, ...extra }))
}

const paths = {
  diskProbe: process.env.HOST_DISK_PROBE?.trim() || '/host/disk-probe',
  meminfo: process.env.HOST_MEMINFO?.trim() || '/host/meminfo',
}
const intervalMs = Number(process.env.HOST_SAMPLE_INTERVAL_MS) || 60_000
const bffUrl = process.env.BFF_INTERNAL_URL?.trim()
const token = process.env.INTERNAL_API_TOKEN?.trim()

// 没有内部令牌的部署照样能起：读数进不了看板，但采集本身（以及挂在它上面的宿主机告警）不受影响。
if (!bffUrl || !token) {
  say('warn', 'collector.reporting_disabled', {
    reason:
      'BFF_INTERNAL_URL or INTERNAL_API_TOKEN is not set; samples will not reach the operations board',
  })
}

const stop = runCollector({
  intervalMs,
  read: () => readHostSample(paths),
  report: bffUrl && token ? createReporter(bffUrl, token) : async () => {},
})

say('info', 'collector.started', { ...paths, intervalMs, reporting: Boolean(bffUrl && token) })

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stop()
    process.exit(0)
  })
}
