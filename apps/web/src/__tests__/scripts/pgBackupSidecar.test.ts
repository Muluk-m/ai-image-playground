import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * 2026-09-17 18:00 UTC 宿主机正好宕着，busybox crond 不补跑错过的任务，备份告警每小时响一次，
 * 直到有人手动跑了 backup.sh。容器启动时的补跑就是补这个洞；它的判断在 deploy/backup/lib.sh 里，
 * 这里用假的 aws 与假的 backup.sh / restore-drill.sh 钉住「什么时候补、什么时候不补」。
 */
const lib = resolve(__dirname, '../../../../../deploy/backup/lib.sh')

const hour = 60 * 60 * 1000
const day = 24 * hour

let root: string
let calls: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pg-backup-sidecar-'))
  calls = join(root, 'calls')
  const fake = (name: string, body: string) => {
    writeFileSync(join(root, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(root, name), 0o755)
  }
  // 列举失败时像真的 aws 一样往 stderr 写一行并以非零退出；否则按前缀给出预设的「key 修改时间」。
  fake(
    'aws',
    [
      'echo "aws $*" >> "$CALL_LOG"',
      'if [ -n "${FAKE_LIST_FAILS:-}" ]; then echo "Could not connect to the endpoint URL" >&2; exit 255; fi',
      'case "$*" in',
      '  *"--prefix app/pg/drill/"*) printf "%s\\n" "$FAKE_DRILL" ;;',
      '  *"--prefix app/pg/"*) printf "%s\\n" "$FAKE_DUMP" ;;',
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'),
  )
  fake('backup.sh', 'echo backup.sh >> "$CALL_LOG"')
  fake('restore-drill.sh', 'echo restore-drill.sh >> "$CALL_LOG"')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** aws-cli `--output text` 打印 LastModified 的样子。 */
function modifiedAgo(ms: number): string {
  return `${new Date(Date.now() - ms).toISOString().slice(0, 19)}+00:00`
}

function catchUp(listing: { dump: string; drill: string; listFails?: boolean }) {
  const result = spawnSync('sh', ['-c', '. "$0"; catch_up', lib], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      PATH: `${root}:${process.env.PATH}`,
      CALL_LOG: calls,
      S3_ENDPOINT: 'https://r2.example',
      S3_BUCKET: 'bucket',
      S3_KEY_PREFIX: '/app/',
      S3_ACCESS_KEY_ID: 'id',
      S3_SECRET_ACCESS_KEY: 'secret',
      BACKUP_HEALTH_FILE: join(root, 'last-success'),
      FAKE_DUMP: listing.dump,
      FAKE_DRILL: listing.drill,
      FAKE_LIST_FAILS: listing.listFails ? '1' : '',
    },
  })
  const log = existsSync(calls) ? readFileSync(calls, 'utf8') : ''
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    scripts: log.split('\n').filter((line) => line.endsWith('.sh')),
  }
}

const freshDrill = `app/pg/drill/latest.json\t${modifiedAgo(day)}`
const freshDump = `app/pg/2026-09-18.dump.sha256\t${modifiedAgo(hour / 3)}`

describe('容器启动时补跑备份', () => {
  it('最新一份 dump 已经 30 小时了：补跑一次备份', () => {
    const run = catchUp({
      dump: `app/pg/2026-09-16.dump\t${modifiedAgo(30 * hour)}`,
      drill: freshDrill,
    })
    expect(run.status).toBe(0)
    expect(run.scripts).toEqual(['backup.sh'])
  })

  it('桶里一份 dump 都没有：补跑一次备份', () => {
    const run = catchUp({ dump: 'None', drill: freshDrill })
    expect(run.status).toBe(0)
    expect(run.scripts).toEqual(['backup.sh'])
  })

  it('handles the AWS CLI two-null-column representation of an empty bucket', () => {
    const run = catchUp({ dump: 'None\tNone', drill: freshDrill })
    expect(run.status).toBe(0)
    expect(run.scripts).toEqual(['backup.sh'])
    expect(existsSync(join(root, 'last-success'))).toBe(false)
  })

  it('最新一份 dump 才 20 分钟：重新部署不再多备一份，健康时间沿用上传时间', () => {
    const run = catchUp({ dump: freshDump, drill: freshDrill })
    expect(run.status).toBe(0)
    expect(run.scripts).toEqual([])
    const saved = Number(readFileSync(join(root, 'last-success'), 'utf8'))
    expect(saved).toBeLessThan(Date.now() / 1000 - 1000)
  })

  it('列举失败（网络不通）：什么都不跑，留一行日志，交给 cron', () => {
    const run = catchUp({ dump: freshDump, drill: freshDrill, listFails: true })
    expect(run.status).toBe(0)
    expect(run.scripts).toEqual([])
    expect(run.output).toContain('could not list')
    expect(existsSync(join(root, 'last-success'))).toBe(false)
  })
})

describe('容器启动时补跑恢复演练', () => {
  it('还从来没演练过：新部署立刻演练一次', () => {
    const run = catchUp({ dump: freshDump, drill: 'None' })
    expect(run.scripts).toEqual(['restore-drill.sh'])
  })

  it('上一次演练是 9 天前（错过了一个周日）：补跑', () => {
    const run = catchUp({
      dump: freshDump,
      drill: `app/pg/drill/latest.json\t${modifiedAgo(9 * day)}`,
    })
    expect(run.scripts).toEqual(['restore-drill.sh'])
  })

  it('上一次演练是 1 天前：不跑', () => {
    const run = catchUp({ dump: freshDump, drill: freshDrill })
    expect(run.scripts).toEqual([])
  })

  it('备份与演练都欠着：先备份，再拿这份新备份演练', () => {
    const run = catchUp({ dump: 'None', drill: 'None' })
    expect(run.scripts).toEqual(['backup.sh', 'restore-drill.sh'])
  })
})

describe('backup health never comes from container start time', () => {
  const health = resolve(__dirname, '../../../../../deploy/backup/healthcheck.sh')
  const check = () =>
    spawnSync('sh', [health], {
      env: { ...process.env, BACKUP_HEALTH_FILE: join(root, 'last-success') },
    }).status
  it('rejects missing, invalid, stale and future upload times', () => {
    expect(check()).toBe(1)
    for (const value of [
      'garbage',
      `${Math.floor(Date.now() / 1000) - 7300}`,
      `${Math.floor(Date.now() / 1000) + 60}`,
    ]) {
      writeFileSync(join(root, 'last-success'), value)
      expect(check()).toBe(1)
    }
    writeFileSync(join(root, 'last-success'), `${Math.floor(Date.now() / 1000) - 1200}`)
    expect(check()).toBe(0)
  })
})
