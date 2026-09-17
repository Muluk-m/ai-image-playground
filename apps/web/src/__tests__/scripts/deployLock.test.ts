import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * 两个会话隔 52 秒先后对同一台生产机发起 `vps-deploy.sh all`：四个镜像挨着 PostgreSQL、两套
 * 后端和 cloudflared 一起构建，整机失去响应，API 对外 530。这里钉的是防复发的那把锁：
 * 第二个部署被拒绝而不是排队（排队等于上一轮一结束就自动叠下一轮），持锁进程没了的锁能被收回，
 * 被拒绝的那一方退出时不能顺手删掉别人的锁。
 */
const lib = resolve(__dirname, '../../../../../scripts/lib/deploy-common.sh')

let root: string
let lock: string

function run(script: string): { code: number; err: string } {
  const done = spawnSync('sh', ['-c', `. "$0"; ${script}`, lib], { encoding: 'utf8' })
  return { code: done.status ?? -1, err: done.stderr }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deploy-lock-'))
  lock = join(root, 'deploy.lock')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('acquire_deploy_lock', () => {
  it('没人持锁时拿得到，并写下是谁、什么时候、在部署什么', () => {
    const result = run(`acquire_deploy_lock "${lock}" "all origin/main"; cat "${lock}/info" >&2`)
    expect(result.code).toBe(0)
    expect(result.err).toMatch(/pid=\d+ started=\S+ by=\S+ what=all origin\/main/)
  })

  it('持锁进程还活着时，第二个部署被拒绝，并看得到对方的信息', async () => {
    const holder = spawn('sleep', ['30'])
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'pid'), `${holder.pid}\n`)
      writeFileSync(join(lock, 'info'), `pid=${holder.pid} started=2026-09-17T16:33:00Z what=all\n`)

      const result = run(`acquire_deploy_lock "${lock}" "all origin/main"`)
      expect(result.code).toBe(1)
      expect(result.err).toContain('another deploy is running')
      expect(result.err).toContain('started=2026-09-17T16:33:00Z')
      expect(readFileSync(join(lock, 'pid'), 'utf8').trim()).toBe(String(holder.pid))
    } finally {
      holder.kill()
    }
  })

  it('被拒绝的那一方退出时不会删掉别人的锁', () => {
    const holder = spawn('sleep', ['30'])
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'pid'), `${holder.pid}\n`)
      run(`acquire_deploy_lock "${lock}" "all" || true; release_deploy_lock`)
      expect(existsSync(join(lock, 'pid'))).toBe(true)
    } finally {
      holder.kill()
    }
  })

  it('持锁进程已经没了的锁会被收回', () => {
    mkdirSync(lock)
    // 一个肯定不存在的 pid：比任何系统的 pid 上限都大。
    writeFileSync(join(lock, 'pid'), '99999999\n')
    const result = run(`acquire_deploy_lock "${lock}" "paid"; cat "${lock}/info" >&2`)
    expect(result.code).toBe(0)
    expect(result.err).toContain('Reclaiming a deploy lock')
    expect(result.err).toContain('what=paid')
  })

  it('刚建好还没写 pid 的锁视为对方正在起步，不去抢', () => {
    mkdirSync(lock)
    const result = run(`acquire_deploy_lock "${lock}" "all"`)
    expect(result.code).toBe(1)
    expect(result.err).toContain('another deploy is starting')
  })

  it('自己持有的锁在收尾时释放', () => {
    const result = run(`acquire_deploy_lock "${lock}" "all"; release_deploy_lock`)
    expect(result.code).toBe(0)
    expect(existsSync(lock)).toBe(false)
  })
})

describe('available_memory_mb', () => {
  it('读 MemAvailable，换算成整 MB', () => {
    const meminfo = join(root, 'meminfo')
    writeFileSync(meminfo, 'MemTotal:        3995000 kB\nMemAvailable:    1536000 kB\n')
    const out = execFileSync('sh', ['-c', `. "$0"; available_memory_mb`, lib], {
      encoding: 'utf8',
      env: { ...process.env, DEPLOY_MEMINFO_FILE: meminfo },
    })
    expect(out).toBe('1500')
  })

  it('没有 meminfo 的宿主机（macOS）什么都不输出，由调用方跳过检查', () => {
    const out = execFileSync('sh', ['-c', `. "$0"; available_memory_mb`, lib], {
      encoding: 'utf8',
      env: { ...process.env, DEPLOY_MEMINFO_FILE: join(root, 'absent') },
    })
    expect(out).toBe('')
  })
})
