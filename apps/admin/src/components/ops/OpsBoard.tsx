import { OPS_THRESHOLDS } from '@image-playground/shared'
import { Link } from '@tanstack/react-router'

import { Kpi } from '@/components/Kpi'
import { ApiBody, apiProblems } from '@/components/ops/ApiBlock'
import { ContainersBody, containersProblems } from '@/components/ops/ContainersBlock'
import {
  currentDeployment,
  DeploymentsBody,
  deploymentsProblems,
  runsDeployment,
  shortSha,
} from '@/components/ops/DeploymentsBlock'
import { LazyHostTrendChart } from '@/components/ops/LazyHostTrendChart'
import { OpsBlockCard } from '@/components/ops/OpsBlockCard'
import { bytes, elapsed, fuzzyTime, isoTime, shortId } from '@/lib/format'
import type {
  OpsBackups,
  OpsDatabase,
  OpsDeployments,
  OpsHost,
  OpsQueue,
  OpsServiceName,
  OpsServices,
  OpsSnapshot,
} from '@/lib/types'

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function diskUsedRatio(host: NonNullable<OpsHost['latest']>): number {
  return 1 - host.disk_available_bytes / host.disk_total_bytes
}

/** 没启用采集容器不算出事：它是可选的。启用了却断了采样，才是。 */
function hostProblems({ latest }: OpsHost, now: number): string[] {
  if (!latest) return []
  const problems: string[] = []
  const used = diskUsedRatio(latest)
  if (used >= OPS_THRESHOLDS.DISK_USED_RATIO) {
    problems.push(`磁盘已用 ${percent(used)}，只剩 ${bytes(latest.disk_available_bytes)}`)
  }
  const memory = latest.mem_available_bytes / latest.mem_total_bytes
  if (memory < OPS_THRESHOLDS.MEMORY_CRITICAL_RATIO) {
    problems.push(`可用内存只剩 ${percent(memory)}，快要耗尽，机器随时可能卡死`)
  } else if (memory < OPS_THRESHOLDS.MEMORY_AVAILABLE_RATIO) {
    problems.push(`可用内存只剩 ${percent(memory)}`)
  }
  if (latest.cpu_busy_ratio != null && latest.cpu_busy_ratio >= OPS_THRESHOLDS.CPU_BUSY_RATIO) {
    problems.push(`CPU 使用率 ${percent(latest.cpu_busy_ratio)}`)
  }
  if (latest.booted_at != null && now - latest.booted_at < OPS_THRESHOLDS.RECENT_BOOT_MS) {
    problems.push(`机器 ${elapsed(now - latest.booted_at)}前重启过`)
  }
  const silence = now - latest.sampled_at
  if (silence > OPS_THRESHOLDS.HOST_SAMPLE_MAX_AGE_MS) {
    problems.push(`已经 ${elapsed(silence)}没有新的采样，下面的数字是旧的`)
  }
  return problems
}

function loadNote(latest: NonNullable<OpsHost['latest']>): string | undefined {
  const loads = [latest.load_1, latest.load_5, latest.load_15]
  if (loads.some((value) => value == null)) return undefined
  const cores = latest.cpu_count ? `${latest.cpu_count} 核 · ` : ''
  return `${cores}负载 ${loads.map((value) => (value as number).toFixed(2)).join(' / ')}`
}

function HostBody({ host, now }: { host: OpsHost; now: number }) {
  const { latest, series } = host
  if (!latest) {
    return (
      <div>
        <p className="text-sm font-medium text-muted-foreground">未启用</p>
        <p className="mt-1 text-xs text-muted-foreground">
          采集容器没有在跑，所以看不到宿主机的磁盘与内存。
        </p>
      </div>
    )
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Kpi
          variant="inline"
          label="磁盘已用"
          value={percent(diskUsedRatio(latest))}
          note={`剩 ${bytes(latest.disk_available_bytes)} / 共 ${bytes(latest.disk_total_bytes)}`}
        />
        <Kpi
          variant="inline"
          label="可用内存"
          value={bytes(latest.mem_available_bytes)}
          note={`共 ${bytes(latest.mem_total_bytes)}`}
        />
        <Kpi
          variant="inline"
          label="CPU"
          value={latest.cpu_busy_ratio == null ? '—' : percent(latest.cpu_busy_ratio)}
          note={loadNote(latest)}
        />
        <Kpi
          variant="inline"
          label="Swap 已用"
          value={
            latest.swap_total_bytes == null || latest.swap_free_bytes == null
              ? '—'
              : latest.swap_total_bytes === 0
                ? '未启用'
                : bytes(latest.swap_total_bytes - latest.swap_free_bytes)
          }
          note={latest.swap_total_bytes ? `共 ${bytes(latest.swap_total_bytes)}` : undefined}
        />
        <Kpi
          variant="inline"
          label="开机于"
          value={latest.booted_at == null ? '—' : fuzzyTime(latest.booted_at, now)}
          note={latest.booted_at == null ? undefined : `${isoTime(latest.booted_at)} UTC`}
        />
        <Kpi variant="inline" label="最近采样" value={fuzzyTime(latest.sampled_at, now)} />
      </div>
      {series.length > 1 ? (
        <LazyHostTrendChart
          series={series}
          diskAlertRatio={OPS_THRESHOLDS.DISK_USED_RATIO}
          label="近 7 天的磁盘、内存与 CPU 用量"
        />
      ) : (
        <p className="border-t pt-3 text-xs text-muted-foreground">采样还不够画出趋势。</p>
      )}
    </>
  )
}

const SERVICE_LABEL: Record<OpsServiceName, string> = { bff: '后端', worker: 'worker' }
const EXPECTED_SERVICES: readonly OpsServiceName[] = ['bff', 'worker']

function servicesProblems(
  { services }: OpsServices,
  now: number,
  deployments: OpsDeployments | null,
): string[] {
  const problems: string[] = []
  const current = currentDeployment(deployments)
  for (const name of EXPECTED_SERVICES) {
    const instances = services.filter((one) => one.service === name)
    const freshest = instances[0]
    if (!freshest) {
      problems.push(`${SERVICE_LABEL[name]} 还没有心跳`)
      continue
    }
    const silence = now - freshest.last_seen_at
    if (silence > OPS_THRESHOLDS.HEARTBEAT_MAX_AGE_MS) {
      problems.push(`${SERVICE_LABEL[name]}的心跳已经断了 ${elapsed(silence)}`)
      continue
    }
    // 同时活着好几个版本是发布流程的常态（新的在服务、旧的在排空）；要紧的是刚部署的那版在不在跑。
    const alive = instances.filter(
      (one) => now - one.last_seen_at <= OPS_THRESHOLDS.HEARTBEAT_MAX_AGE_MS,
    )
    if (current && !alive.some((one) => runsDeployment(one.version, current))) {
      problems.push(
        `${SERVICE_LABEL[name]}没有实例在跑最近部署的版本 ${shortSha(current.public_sha)}`,
      )
    }
  }
  return problems
}

function ServicesBody({
  services,
  now,
  deployments,
}: {
  services: OpsServices
  now: number
  deployments: OpsDeployments | null
}) {
  if (services.services.length === 0) {
    return <p className="text-sm text-muted-foreground">还没有任何服务写过心跳。</p>
  }
  const current = currentDeployment(deployments)
  return (
    <ul className="space-y-3 text-sm">
      {services.services.map((service) => {
        const alive = now - service.last_seen_at <= OPS_THRESHOLDS.HEARTBEAT_MAX_AGE_MS
        const note = !alive
          ? '已断开'
          : current === null
            ? null
            : runsDeployment(service.version, current)
              ? '当前版本'
              : '旧版本实例'
        return (
          <li
            key={`${service.service}-${service.instance}`}
            className="flex flex-wrap items-baseline justify-between gap-x-4"
          >
            <span className="font-medium">{SERVICE_LABEL[service.service]}</span>
            <span
              className="font-mono text-xs text-muted-foreground"
              title={`${service.version}（实例 ${service.instance}）`}
            >
              {service.version.split('+').map(shortSha).join('+')}
              {note ? <span className="ml-2 font-sans">{note}</span> : null}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {fuzzyTime(service.last_seen_at, now)}
            </span>
            {service.last_successful_poll_at !== null ? (
              <span className="w-full text-xs text-muted-foreground">
                最后一次成功轮询：{fuzzyTime(service.last_successful_poll_at, now)}
              </span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function queueProblems(queue: OpsQueue): string[] {
  const problems: string[] = []
  if (
    queue.oldest_queued_wait_ms !== null &&
    queue.oldest_queued_wait_ms > OPS_THRESHOLDS.QUEUE_WAIT_MS
  ) {
    problems.push(`最老的排队任务已经等了 ${elapsed(queue.oldest_queued_wait_ms)}`)
  }
  if (queue.stuck.length > 0) {
    // 后台看不到 worker 手里正拿着哪些任务：上传大产物的长视频会合法地超过这个时长，
    // 所以这里只说「运行超过」，不替 worker 下「卡住」的结论。
    problems.push(
      `${queue.stuck.length} 个任务运行超过 ${elapsed(queue.stale_after_ms)}，可能卡住了`,
    )
  }
  return problems
}

function QueueBody({ queue, now }: { queue: OpsQueue; now: number }) {
  return (
    <>
      <div className="grid grid-cols-3 gap-4">
        <Kpi variant="inline" label="排队" value={String(queue.queued)} />
        <Kpi variant="inline" label="运行中" value={String(queue.in_progress)} />
        <Kpi
          variant="inline"
          label="最老的等了"
          value={
            queue.oldest_queued_wait_ms === null
              ? '没有在等的任务'
              : elapsed(queue.oldest_queued_wait_ms)
          }
        />
      </div>
      {queue.stuck.length > 0 ? (
        <ul className="space-y-1 border-t pt-3 text-xs">
          {queue.stuck.map((task) => (
            <li key={task.id} className="flex items-center justify-between gap-3">
              <Link
                to="/tasks/$taskId"
                params={{ taskId: task.id }}
                className="font-mono text-foreground underline-offset-2 hover:underline"
                title={task.id}
              >
                {shortId(task.id, 14)}
              </Link>
              <span className="truncate text-muted-foreground">{task.model}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                已运行 {elapsed(now - task.started_at)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

function DatabaseBody({ database }: { database: OpsDatabase }) {
  return (
    <>
      <Kpi variant="inline" label="总大小" value={bytes(database.size_bytes)} />
      <ul className="space-y-1 border-t pt-3 text-xs">
        {database.tables.map((table) => (
          <li key={table.name} className="flex items-center justify-between gap-3">
            <span className="truncate font-mono">{table.name}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {bytes(table.bytes)}
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

function backupProblems(backup: OpsBackups, now: number): string[] {
  const { latest, previous } = backup
  if (!latest) return ['还没有备份']
  const problems: string[] = []
  const age = now - latest.modified_at
  if (age > OPS_THRESHOLDS.BACKUP_MAX_AGE_MS) {
    problems.push(`最新的备份是 ${elapsed(age)}前的，备份每小时一次`)
  }
  if (previous && latest.size_bytes < previous.size_bytes * OPS_THRESHOLDS.BACKUP_SHRINK_RATIO) {
    problems.push(`最新一份（${bytes(latest.size_bytes)}）比前一份小了一大半，dump 可能半途而废`)
  }
  return problems
}

/** `pg/2026-09-17.dump` → `2026-09-17`；认不出就原样显示 key。 */
function backupDate(key: string): string {
  return /(\d{4}-\d{2}-\d{2})\.dump$/.exec(key)?.[1] ?? key
}

function BackupBody({ backup, now }: { backup: OpsBackups; now: number }) {
  const { latest, previous } = backup
  if (!latest) {
    return <p className="text-sm text-muted-foreground">备份前缀下没有任何文件。</p>
  }
  return (
    <>
      <div className="grid grid-cols-3 gap-4">
        <Kpi variant="inline" label="最新一份" value={backupDate(latest.key)} />
        <Kpi variant="inline" label="大小" value={bytes(latest.size_bytes)} />
        <Kpi variant="inline" label="完成于" value={fuzzyTime(latest.modified_at, now)} />
      </div>
      {previous ? (
        <p className="border-t pt-3 text-xs text-muted-foreground">
          前一份 {backupDate(previous.key)} · {bytes(previous.size_bytes)}
        </p>
      ) : null}
    </>
  )
}

/**
 * 全后台顶部那条窄横幅用：把看板每一栏的问题汇总成一串。顺序跟看板里的栏一致，
 * 所以横幅上那句话就是运营者滚到看板顶上会看到的第一句。
 * 取不到的栏不算出事——看板里也是这么处理的（只有那一栏说取不到）。
 */
export function opsAlerts(snapshot: OpsSnapshot): string[] {
  const now = snapshot.generated_at
  const deployments = snapshot.deployments.ok ? snapshot.deployments.data : null
  return [
    ...(snapshot.host.ok ? hostProblems(snapshot.host.data, now) : []),
    ...(snapshot.containers.ok ? containersProblems(snapshot.containers.data) : []),
    ...(snapshot.services.ok ? servicesProblems(snapshot.services.data, now, deployments) : []),
    ...(snapshot.api.ok ? apiProblems(snapshot.api.data) : []),
    ...(snapshot.queue.ok ? queueProblems(snapshot.queue.data) : []),
    ...(snapshot.backup.ok ? backupProblems(snapshot.backup.data, now) : []),
    ...(snapshot.deployments.ok ? deploymentsProblems(snapshot.deployments.data) : []),
  ]
}

/** 回答「这套部署现在有没有出事」。业务跑得怎么样是概览页的事，这里不重复。 */
export function OpsBoard({ snapshot }: { snapshot: OpsSnapshot }) {
  const deployments = snapshot.deployments.ok ? snapshot.deployments.data : null
  return (
    <section className="grid gap-4 xl:grid-cols-2">
      <OpsBlockCard
        title="宿主机"
        block={snapshot.host}
        problems={(host) => hostProblems(host, snapshot.generated_at)}
      >
        {(host) => <HostBody host={host} now={snapshot.generated_at} />}
      </OpsBlockCard>
      <OpsBlockCard title="容器" block={snapshot.containers} problems={containersProblems}>
        {(containers) => <ContainersBody containers={containers} now={snapshot.generated_at} />}
      </OpsBlockCard>
      <OpsBlockCard
        title="服务"
        block={snapshot.services}
        problems={(services) => servicesProblems(services, snapshot.generated_at, deployments)}
      >
        {(services) => (
          <ServicesBody services={services} now={snapshot.generated_at} deployments={deployments} />
        )}
      </OpsBlockCard>
      <OpsBlockCard title="接口" block={snapshot.api} problems={apiProblems}>
        {(api) => <ApiBody api={api} />}
      </OpsBlockCard>
      <OpsBlockCard title="队列" block={snapshot.queue} problems={queueProblems}>
        {(queue) => <QueueBody queue={queue} now={snapshot.generated_at} />}
      </OpsBlockCard>
      <OpsBlockCard
        title="备份"
        block={snapshot.backup}
        problems={(backup) => backupProblems(backup, snapshot.generated_at)}
      >
        {(backup) => <BackupBody backup={backup} now={snapshot.generated_at} />}
      </OpsBlockCard>
      <OpsBlockCard title="部署记录" block={snapshot.deployments} problems={deploymentsProblems}>
        {(deployments) => <DeploymentsBody deployments={deployments} now={snapshot.generated_at} />}
      </OpsBlockCard>
      <OpsBlockCard title="数据库" block={snapshot.database} problems={() => []}>
        {(database) => <DatabaseBody database={database} />}
      </OpsBlockCard>
    </section>
  )
}
