import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * 2026-09-18 凌晨两个会话相隔 52 秒，在生产 VPS 的同一个检出目录里各自跑起了
 * `scripts/vps-deploy.sh all`，目标提交还不一样：两套镜像同时构建，主机过载，两个 API 一起 530。
 * 互斥锁就是拦这件事的，锁的原语是 `mkdir` 原子建目录（macOS 没有 flock(1)）。
 * 真正的 docker 与 git 步骤在 vps-deploy.sh 里，这里只钉 deploy-common.sh 里那几个函数的行为。
 */
const lib = resolve(__dirname, '../../../../../scripts/lib/deploy-common.sh')

function sh(script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('sh', ['-c', `. "$0"; ${script}`, lib, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

let root: string
let lockDir: string
let ownerFile: string
const running: ChildProcess[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deploy-lock-'))
  lockDir = join(root, 'deploy.lock')
  ownerFile = join(lockDir, 'owner')
})

afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL')
  rmSync(root, { recursive: true, force: true })
})

/** 一个活着的、跟测试无关的进程，用来扮演锁的持有者。 */
function livePid(): number {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' })
  running.push(child)
  return child.pid as number
}

/** 一个确定已经退出的 PID：进程自己打印了 PID 之后才退出。 */
function deadPid(): number {
  const out = spawnSync('sh', ['-c', 'echo $$'], { encoding: 'utf8' }).stdout.trim()
  return Number(out)
}

function writeOwner(fields: Record<string, string>) {
  mkdirSync(lockDir, { recursive: true })
  const all = {
    token: '-',
    since: '2026-09-18T00:33:12Z',
    by: 'someone@tx-vps',
    what: 'editions=internal paid ref=39d2cf1c',
    ...fields,
  }
  writeFileSync(
    ownerFile,
    `${Object.entries(all)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')}\n`,
  )
}

/** 伪造一个 /proc：Linux 上 starttime 是 /proc/<pid>/stat 的第 22 个字段。 */
function fakeProc(pid: number, starttime: string): string {
  const procRoot = join(root, 'proc')
  mkdirSync(join(procRoot, String(pid)), { recursive: true })
  const between = Array.from({ length: 18 }, () => '0').join(' ')
  writeFileSync(
    join(procRoot, String(pid), 'stat'),
    `${pid} (sleep with (parens)) S ${between} ${starttime} 0 0\n`,
  )
  return procRoot
}

describe('acquire_deploy_lock', () => {
  it('抢到锁后 owner 文件记下 PID、发起人和这次部署的目标', () => {
    const result = sh('acquire_deploy_lock "$1" "$2"', [
      lockDir,
      'editions=internal paid ref=origin/main',
    ])
    expect(result.status).toBe(0)
    const owner = readFileSync(ownerFile, 'utf8')
    expect(owner).toMatch(/^pid=\d+$/m)
    expect(owner).toMatch(/^since=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m)
    expect(owner).toMatch(/^by=\S+@\S+$/m)
    expect(owner).toMatch(/^what=editions=internal paid ref=origin\/main$/m)
  })

  it('锁被活着的进程持有时立刻失败，并把持有者原样打给 stderr', () => {
    const pid = livePid()
    writeOwner({ pid: String(pid) })
    const before = readFileSync(ownerFile, 'utf8')

    const result = sh('acquire_deploy_lock "$1" "$2"', [lockDir, 'editions=paid ref=0d9a5cb8'])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`pid=${pid}`)
    expect(result.stderr).toContain('someone@tx-vps')
    expect(result.stderr).toContain('editions=internal paid ref=39d2cf1c')
    // 第二个会话不许把第一个的 owner 覆盖掉。
    expect(readFileSync(ownerFile, 'utf8')).toBe(before)
  })

  it('持有者进程已经不在了就说明一句并接管', () => {
    writeOwner({ pid: String(deadPid()) })
    const result = sh('acquire_deploy_lock "$1" "$2"', [
      lockDir,
      'editions=internal ref=origin/main',
    ])
    expect(result.status).toBe(0)
    expect(result.stdout + result.stderr).toMatch(/stale/i)
    expect(readFileSync(ownerFile, 'utf8')).toContain('what=editions=internal ref=origin/main')
  })

  it('PID 被复用时不误判成活着的持有者（Linux 的 /proc starttime 分支）', () => {
    const pid = livePid()
    writeOwner({ pid: String(pid), token: '111' })
    const result = sh(
      'acquire_deploy_lock "$1" "$2"',
      [lockDir, 'editions=internal ref=origin/main'],
      {
        DEPLOY_PROC_ROOT: fakeProc(pid, '999'),
      },
    )
    expect(result.status).toBe(0)
    const owner = readFileSync(ownerFile, 'utf8')
    expect(owner).not.toContain(`pid=${pid}`)
    expect(owner).toContain('what=editions=internal ref=origin/main')
  })

  it('starttime 对得上就是同一个进程，照样拒绝', () => {
    const pid = livePid()
    writeOwner({ pid: String(pid), token: '999' })
    const result = sh(
      'acquire_deploy_lock "$1" "$2"',
      [lockDir, 'editions=internal ref=origin/main'],
      {
        DEPLOY_PROC_ROOT: fakeProc(pid, '999'),
      },
    )
    expect(result.status).not.toBe(0)
  })

  it('没有 /proc 的平台（macOS）退回到只看 kill -0，活着就拒绝', () => {
    const pid = livePid()
    writeOwner({ pid: String(pid), token: '111' })
    const result = sh(
      'acquire_deploy_lock "$1" "$2"',
      [lockDir, 'editions=internal ref=origin/main'],
      {
        DEPLOY_PROC_ROOT: join(root, 'no-proc-here'),
      },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`pid=${pid}`)
  })

  it('owner 文件读不出 PID 时保守拒绝，不抢', () => {
    mkdirSync(lockDir, { recursive: true })
    const result = sh('acquire_deploy_lock "$1" "$2"', [
      lockDir,
      'editions=internal ref=origin/main',
    ])
    expect(result.status).not.toBe(0)
  })
})

describe('release_deploy_lock', () => {
  it('释放自己持有的锁', () => {
    const result = sh('acquire_deploy_lock "$1" hold; release_deploy_lock "$1"; [ -d "$1" ]', [
      lockDir,
    ])
    expect(result.status).not.toBe(0) // 目录没了，[ -d ] 失败
  })

  it('别人的锁不动，调用本身也不报错', () => {
    writeOwner({ pid: String(livePid()) })
    const before = readFileSync(ownerFile, 'utf8')
    const result = sh('release_deploy_lock "$1"', [lockDir])
    expect(result.status).toBe(0)
    expect(readFileSync(ownerFile, 'utf8')).toBe(before)
  })

  it('锁本来就不存在时静默成功', () => {
    expect(sh('release_deploy_lock "$1"', [lockDir]).status).toBe(0)
  })
})

describe('两个部署同时抢锁', () => {
  // 抢锁是 mkdir 的原子性，不靠 sleep 错开：两个子进程先在同一个屏障文件上自旋，屏障一放开就抢。
  // 赢的那个抢到后继续持有（等第二个屏障文件），所以输的那个看到的一定是「活着的持有者」。
  async function race(): Promise<string[]> {
    const barrier = join(root, 'go')
    const hold = join(root, 'stop')
    const script = `
      while [ ! -f "$2" ]; do :; done
      if acquire_deploy_lock "$1" "race" >/dev/null 2>&1; then
        echo won
        while [ ! -f "$3" ]; do :; done
      else
        echo lost
      fi
    `
    const children = [0, 1].map(() =>
      spawn('sh', ['-c', `. "$0"; ${script}`, lib, lockDir, barrier, hold], {
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    )
    const lines = children.map(
      (child) =>
        new Promise<string>((done) => {
          child.stdout?.on('data', (chunk: Buffer) => done(chunk.toString().trim()))
        }),
    )
    writeFileSync(barrier, '')
    const reported = await Promise.all(lines)
    writeFileSync(hold, '')
    for (const child of children) child.kill('SIGKILL')
    rmSync(lockDir, { recursive: true, force: true })
    rmSync(barrier, { force: true })
    rmSync(hold, { force: true })
    return reported
  }

  it('永远只有一个抢到', async () => {
    for (let round = 0; round < 10; round++) {
      const reported = await race()
      expect(reported.filter((line) => line === 'won')).toHaveLength(1)
      expect(reported.filter((line) => line === 'lost')).toHaveLength(1)
    }
  })
})

describe('should_prune_build_cache', () => {
  const decide = (freeGb: number, thresholdGb: number) =>
    sh('if should_prune_build_cache "$1" "$2"; then echo prune; else echo keep; fi', [
      String(freeGb),
      String(thresholdGb),
    ]).stdout.trim()

  it('空间低于门槛才清', () => {
    expect(decide(14, 15)).toBe('prune')
  })

  it('刚好等于门槛就留着', () => {
    expect(decide(15, 15)).toBe('keep')
  })

  it('空间充裕时不动缓存', () => {
    expect(decide(40, 15)).toBe('keep')
  })
})
