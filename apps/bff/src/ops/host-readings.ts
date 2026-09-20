import { readdir, readFile, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContainerSample, HostSample } from '@image-playground/shared'

/**
 * 采集容器从宿主机读到的原始文件，以及把它们变成一次读数的纯函数。
 * 这里只读只读挂进来的文件，不碰 Docker socket（ADR 0007）。除了磁盘和内存，
 * 其余每一项都是尽力而为：某个文件读不到，那一项就留空，这一次读数照样交出去。
 */

export interface MemoryReading {
  totalBytes: number
  availableBytes: number
  swapTotalBytes: number | null
  swapFreeBytes: number | null
}

function meminfoField(text: string, field: string): number | null {
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, 'm').exec(text)
  return match ? Number(match[1]) * 1024 : null
}

/** `MemAvailable` 是内核估的「不换页还能给新进程多少」，比 MemFree 更接近运营者关心的那个数。 */
export function parseMeminfo(text: string): MemoryReading {
  const totalBytes = meminfoField(text, 'MemTotal')
  const availableBytes = meminfoField(text, 'MemAvailable')
  if (totalBytes === null) throw new Error('/proc/meminfo has no MemTotal')
  if (availableBytes === null) throw new Error('/proc/meminfo has no MemAvailable')
  return {
    totalBytes,
    availableBytes,
    swapTotalBytes: meminfoField(text, 'SwapTotal'),
    swapFreeBytes: meminfoField(text, 'SwapFree'),
  }
}

export interface CpuTimes {
  /** 自开机以来所有核累计的非空闲时间与总时间，单位是内核的 tick。 */
  busy: number
  total: number
}

export interface ProcStat {
  cpu: CpuTimes
  cpuCount: number
  bootedAt: number
}

/**
 * `/proc/stat` 的第一行是所有核的累计时间：user nice system idle iowait irq softirq steal …
 * 空闲算 idle 加 iowait；guest 已经算进 user，不再重复加。
 */
export function parseProcStat(text: string): ProcStat {
  const line = /^cpu\s+(.+)$/m.exec(text)
  const boot = /^btime\s+(\d+)$/m.exec(text)
  if (!line || !boot) throw new Error('/proc/stat has no cpu or btime line')
  const fields = line[1].trim().split(/\s+/).map(Number)
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
    fields
  const idleAll = idle + iowait
  const total = user + nice + system + idleAll + irq + softirq + steal
  return {
    cpu: { busy: total - idleAll, total },
    cpuCount: (text.match(/^cpu\d+\s/gm) ?? []).length,
    bootedAt: Number(boot[1]) * 1000,
  }
}

/** 两次读数之间整机的 CPU 忙碌比例，0 到 1。计数器回退（机器重启）时算不出。 */
export function cpuBusyRatio(previous: CpuTimes | null, current: CpuTimes): number | null {
  if (!previous) return null
  const total = current.total - previous.total
  const busy = current.busy - previous.busy
  if (total <= 0 || busy < 0) return null
  return Math.min(1, busy / total)
}

export function parseLoadavg(text: string): [number, number, number] {
  const [one, five, fifteen] = text.trim().split(/\s+/).map(Number)
  if (![one, five, fifteen].every(Number.isFinite)) throw new Error('/proc/loadavg is malformed')
  return [one, five, fifteen]
}

/** 部署脚本写下的「容器 ID<TAB>容器名」对照表。 */
export function parseContainerNames(text: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const line of text.split('\n')) {
    const [id, name] = line.trim().split('\t')
    if (id && name) names.set(id, name)
  }
  return names
}

function statField(text: string, field: string): number | null {
  const match = new RegExp(`^${field}\\s+(\\d+)$`, 'm').exec(text)
  return match ? Number(match[1]) : null
}

/** cgroup v2 下 systemd 驱动与 cgroupfs 驱动各把容器放在哪。 */
const CONTAINER_DIRS: Array<{ parent: string; id: (entry: string) => string | null }> = [
  {
    parent: 'system.slice',
    id: (entry) => /^docker-([0-9a-f]{64})\.scope$/.exec(entry)?.[1] ?? null,
  },
  { parent: 'docker', id: (entry) => (/^[0-9a-f]{64}$/.test(entry) ? entry : null) },
]

export interface ContainerCounters {
  id: string
  memBytes: number
  memLimitBytes: number | null
  cpuUsageUsec: number
  oomKills: number
}

async function readOptional(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null)
}

/** 读 cgroup 根下所有 Docker 容器的计数器。读不到的容器跳过，不影响其余的。 */
export async function readContainerCounters(cgroupRoot: string): Promise<ContainerCounters[]> {
  const found: ContainerCounters[] = []
  for (const layout of CONTAINER_DIRS) {
    const entries = await readdir(join(cgroupRoot, layout.parent)).catch(() => [] as string[])
    for (const entry of entries) {
      const id = layout.id(entry)
      if (!id) continue
      const dir = join(cgroupRoot, layout.parent, entry)
      const [current, stat, max, cpu, events] = await Promise.all([
        readOptional(join(dir, 'memory.current')),
        readOptional(join(dir, 'memory.stat')),
        readOptional(join(dir, 'memory.max')),
        readOptional(join(dir, 'cpu.stat')),
        readOptional(join(dir, 'memory.events')),
      ])
      if (current === null || cpu === null) continue
      // 与 docker stats 同一个口径：减掉可以随时回收的非活跃文件缓存。
      const inactiveFile = stat ? (statField(stat, 'inactive_file') ?? 0) : 0
      const limit = max?.trim()
      found.push({
        id,
        memBytes: Math.max(0, Number(current.trim()) - inactiveFile),
        memLimitBytes: limit && limit !== 'max' ? Number(limit) : null,
        cpuUsageUsec: statField(cpu, 'usage_usec') ?? 0,
        oomKills: events ? (statField(events, 'oom_kill') ?? 0) : 0,
      })
    }
  }
  return found
}

export interface HostPaths {
  /** 宿主机上待测文件系统里的任意一个文件，只读挂进来；statfs 看的是它背后的那块盘。 */
  diskProbe: string
  /** 宿主机的 /proc/meminfo。 */
  meminfo: string
  /** 宿主机的 /proc/stat；缺席时 CPU 与开机时间留空。 */
  procStat?: string
  /** 宿主机的 /proc/loadavg；缺席时负载留空。 */
  loadavg?: string
  /** 宿主机的 cgroup 根目录；缺席时没有容器读数。 */
  cgroupRoot?: string
  /** 部署脚本写下的容器名对照表；缺席时容器只有 ID。 */
  containerNames?: string
}

/**
 * 返回一个读数函数。CPU 使用率要和上一次比，所以上一次的计数器留在这个闭包里；
 * 采集容器重启后的第一次读数，CPU 那几项是空的。
 */
export function createHostReader(paths: HostPaths): (now?: number) => Promise<HostSample> {
  let previousCpu: CpuTimes | null = null
  let previousContainers = new Map<string, { usec: number; at: number }>()

  return async (now = Date.now()) => {
    const [disk, meminfo, stat, loadavg, counters, names] = await Promise.all([
      statfs(paths.diskProbe),
      readFile(paths.meminfo, 'utf8'),
      paths.procStat ? readOptional(paths.procStat) : null,
      paths.loadavg ? readOptional(paths.loadavg) : null,
      paths.cgroupRoot ? readContainerCounters(paths.cgroupRoot) : [],
      paths.containerNames ? readOptional(paths.containerNames) : null,
    ])
    const memory = parseMeminfo(meminfo)

    let cpu: ProcStat | null = null
    try {
      cpu = stat ? parseProcStat(stat) : null
    } catch {
      cpu = null
    }
    let load: [number, number, number] | null = null
    try {
      load = loadavg ? parseLoadavg(loadavg) : null
    } catch {
      load = null
    }

    const nameOf = names ? parseContainerNames(names) : new Map<string, string>()
    const nextContainers = new Map<string, { usec: number; at: number }>()
    const containers: ContainerSample[] = counters.map((counter) => {
      const previous = previousContainers.get(counter.id)
      const elapsedUsec = previous ? (now - previous.at) * 1000 : 0
      const usedUsec = previous ? counter.cpuUsageUsec - previous.usec : -1
      nextContainers.set(counter.id, { usec: counter.cpuUsageUsec, at: now })
      return {
        container_id: counter.id,
        name: nameOf.get(counter.id) ?? null,
        mem_bytes: counter.memBytes,
        mem_limit_bytes: counter.memLimitBytes,
        cpu_cores: elapsedUsec > 0 && usedUsec >= 0 ? usedUsec / elapsedUsec : null,
        oom_kills: counter.oomKills,
      }
    })
    previousContainers = nextContainers

    const busyRatio = cpu ? cpuBusyRatio(previousCpu, cpu.cpu) : null
    if (cpu) previousCpu = cpu.cpu

    return {
      sampled_at: now,
      // bavail 是非特权进程可用的块数，也就是 df 的 Avail；bfree 还含给 root 留的那部分。
      disk_total_bytes: disk.blocks * disk.bsize,
      disk_available_bytes: disk.bavail * disk.bsize,
      mem_total_bytes: memory.totalBytes,
      mem_available_bytes: memory.availableBytes,
      cpu_count: cpu && cpu.cpuCount > 0 ? cpu.cpuCount : null,
      cpu_busy_ratio: busyRatio,
      load_1: load?.[0] ?? null,
      load_5: load?.[1] ?? null,
      load_15: load?.[2] ?? null,
      swap_total_bytes: memory.swapTotalBytes,
      swap_free_bytes: memory.swapFreeBytes,
      booted_at: cpu?.bootedAt ?? null,
      containers,
    }
  }
}
