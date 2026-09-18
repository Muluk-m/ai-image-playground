import { createAlertSender } from './ops/alert-sender'
import { createHostAlerting, createReporter, runCollector } from './ops/host-collector'
import { createHostReader } from './ops/host-readings'

function say(level: 'info' | 'warn', event: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, service: 'host-collector', event, ...extra }))
}

const paths = {
  diskProbe: process.env.HOST_DISK_PROBE?.trim() || '/host/disk-probe',
  meminfo: process.env.HOST_MEMINFO?.trim() || '/host/meminfo',
  procStat: process.env.HOST_PROC_STAT?.trim() || '/host/stat',
  loadavg: process.env.HOST_LOADAVG?.trim() || '/host/loadavg',
  cgroupRoot: process.env.HOST_CGROUP?.trim() || '/host/cgroup',
  containerNames: process.env.HOST_CONTAINER_NAMES?.trim() || '/host/container-names.tsv',
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

// 同一台宿主机上的每套部署各跑一个采集容器、读到同一块盘。宿主机告警只该由其中一套发，
// 其余的把 OPS_HOST_ALERTS 设成 false；它们自己的应用告警（队列、备份、心跳）不受影响。
const hostAlertsEnabled = process.env.OPS_HOST_ALERTS?.trim().toLowerCase() !== 'false'
const webhookUrl = hostAlertsEnabled ? process.env.OPS_ALERT_WEBHOOK_URL?.trim() : undefined
const deployment = process.env.OPS_DEPLOYMENT_NAME?.trim() || 'deployment'

const stop = runCollector({
  intervalMs,
  onSample: createHostAlerting(createAlertSender({ webhookUrl, deployment })),
  read: createHostReader(paths),
  report: bffUrl && token ? createReporter(bffUrl, token) : async () => {},
})

say('info', 'collector.started', {
  ...paths,
  intervalMs,
  reporting: Boolean(bffUrl && token),
  // 只说配没配，地址本身等同于密钥，不进日志。
  alerting: Boolean(webhookUrl),
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    stop()
    process.exit(0)
  })
}
