import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cpuBusyRatio,
  createHostReader,
  parseContainerNames,
  parseLoadavg,
  parseProcStat,
} from '../../ops/host-readings'

const PROC_STAT = `cpu  1000 0 500 8000 500 0 0 0 0 0
cpu0 500 0 250 4000 250 0 0 0 0 0
cpu1 500 0 250 4000 250 0 0 0 0 0
intr 12345
btime 1789695417
processes 99
`

describe('parseProcStat', () => {
  it('counts idle plus iowait as idle, and every cpuN line as one core', () => {
    expect(parseProcStat(PROC_STAT)).toEqual({
      cpu: { busy: 1500, total: 10_000 },
      cpuCount: 2,
      bootedAt: 1_789_695_417_000,
    })
  })
})

describe('cpuBusyRatio', () => {
  it('is the share of the ticks between two readings that were not idle', () => {
    expect(cpuBusyRatio({ busy: 1500, total: 10_000 }, { busy: 2400, total: 11_000 })).toBe(0.9)
  })

  it('has nothing to say on the first reading or after the counters reset', () => {
    expect(cpuBusyRatio(null, { busy: 1, total: 2 })).toBeNull()
    expect(cpuBusyRatio({ busy: 1500, total: 10_000 }, { busy: 10, total: 20 })).toBeNull()
  })
})

describe('small parsers', () => {
  it('reads the three load averages', () => {
    expect(parseLoadavg('0.42 0.34 0.23 1/505 179172\n')).toEqual([0.42, 0.34, 0.23])
  })

  it('reads the deploy script’s id-to-name table and skips blank lines', () => {
    const names = parseContainerNames('abc\timage-playground-paid-bff-1\n\ndef\tpostgres\n')
    expect(names.get('abc')).toBe('image-playground-paid-bff-1')
    expect(names.size).toBe(2)
  })
})

const ID_BFF = 'a'.repeat(64)
const ID_PG = 'b'.repeat(64)

describe('createHostReader', () => {
  let root: string

  async function container(id: string, files: Record<string, string>): Promise<void> {
    const dir = join(root, 'cgroup', 'system.slice', `docker-${id}.scope`)
    await mkdir(dir, { recursive: true })
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text)
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'host-readings-'))
    await writeFile(join(root, 'probe'), 'x')
    await writeFile(
      join(root, 'meminfo'),
      'MemTotal: 4000 kB\nMemAvailable: 1000 kB\nSwapTotal: 2000 kB\nSwapFree: 1500 kB\n',
    )
    await writeFile(join(root, 'stat'), PROC_STAT)
    await writeFile(join(root, 'loadavg'), '1.5 1.0 0.5 2/100 1\n')
    await writeFile(join(root, 'names.tsv'), `${ID_BFF}\timage-playground-paid-bff-1\n`)
    await container(ID_BFF, {
      'memory.current': '300000\n',
      'memory.stat': 'anon 200000\ninactive_file 100000\n',
      'memory.max': 'max\n',
      'cpu.stat': 'usage_usec 1000000\nuser_usec 800000\n',
      'memory.events': 'low 0\nhigh 0\nmax 0\noom 1\noom_kill 1\n',
    })
    await container(ID_PG, {
      'memory.current': '50000\n',
      'memory.max': '1048576\n',
      'cpu.stat': 'usage_usec 0\n',
    })
    // 不是容器的 scope 不该被当成容器。
    await mkdir(join(root, 'cgroup', 'system.slice', 'ssh.service'), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function reader() {
    return createHostReader({
      diskProbe: join(root, 'probe'),
      meminfo: join(root, 'meminfo'),
      procStat: join(root, 'stat'),
      loadavg: join(root, 'loadavg'),
      cgroupRoot: join(root, 'cgroup'),
      containerNames: join(root, 'names.tsv'),
    })
  }

  it('reads the host and every container, naming the ones the deploy script knows', async () => {
    const sample = await reader()(1_000_000)

    expect(sample).toMatchObject({
      mem_total_bytes: 4000 * 1024,
      mem_available_bytes: 1000 * 1024,
      swap_total_bytes: 2000 * 1024,
      swap_free_bytes: 1500 * 1024,
      cpu_count: 2,
      cpu_busy_ratio: null,
      load_1: 1.5,
      load_15: 0.5,
      booted_at: 1_789_695_417_000,
    })
    const byId = new Map(sample.containers?.map((one) => [one.container_id, one]))
    expect(byId.size).toBe(2)
    expect(byId.get(ID_BFF)).toEqual({
      container_id: ID_BFF,
      name: 'image-playground-paid-bff-1',
      mem_bytes: 200_000,
      mem_limit_bytes: null,
      cpu_cores: null,
      oom_kills: 1,
    })
    expect(byId.get(ID_PG)).toMatchObject({ name: null, mem_limit_bytes: 1_048_576, oom_kills: 0 })
  })

  it('turns the second reading’s counter deltas into CPU usage', async () => {
    const read = reader()
    await read(1_000_000)
    await writeFile(
      join(root, 'stat'),
      PROC_STAT.replace('cpu  1000 0 500 8000', 'cpu  1900 0 500 8100'),
    )
    await writeFile(
      join(root, 'cgroup', 'system.slice', `docker-${ID_BFF}.scope`, 'cpu.stat'),
      'usage_usec 31000000\n',
    )

    const second = await read(1_060_000)

    expect(second.cpu_busy_ratio).toBe(0.9)
    const bff = second.containers?.find((one) => one.container_id === ID_BFF)
    // 60 秒里用了 30 秒 CPU：平均半个核。
    expect(bff?.cpu_cores).toBe(0.5)
  })

  it('still reports disk and memory when the optional files are missing', async () => {
    const sample = await createHostReader({
      diskProbe: join(root, 'probe'),
      meminfo: join(root, 'meminfo'),
      procStat: join(root, 'missing-stat'),
      loadavg: join(root, 'missing-loadavg'),
      cgroupRoot: join(root, 'missing-cgroup'),
      containerNames: join(root, 'missing-names'),
    })(1_000_000)

    expect(sample.mem_total_bytes).toBe(4000 * 1024)
    expect(sample).toMatchObject({ cpu_count: null, load_1: null, booted_at: null, containers: [] })
  })
})
