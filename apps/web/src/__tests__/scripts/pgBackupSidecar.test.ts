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
      // 像真的 get-object --range bytes=0-4095 一样：最多写 4096 字节到最后一个参数指定的文件。
      '  *"get-object"*"--key app/pg/drill/latest.json"*"--range bytes=0-4095"*)',
      '    if [ -n "${FAKE_VERDICT_FAILS:-}" ]; then echo "download failed: 403" >&2; exit 1; fi',
      '    for out; do :; done',
      '    printf "%s\\n" "$FAKE_VERDICT" | head -c 4096 > "$out"',
      '    echo "{}" ;;',
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

const passedVerdict =
  '{"ok":true,"finished_at":"2026-10-25T19:00:11Z","dump_key":"pg/x.dump","tables":3,"rows":9}'
const failedVerdict =
  '{"ok":false,"finished_at":"2026-10-25T19:00:11Z","dump_key":"","tables":0,"rows":0,"error":"no completed dump under pg/"}'

function catchUp(listing: {
  dump: string
  drill: string
  listFails?: boolean
  verdict?: string
  verdictFails?: boolean
  retryAfterSeconds?: string
}) {
  // entrypoint.sh 在 set -eu 下跑 catch_up，这里同样开着，返回非零的分支一旦没接住就会在测试里暴露。
  const result = spawnSync('sh', ['-c', 'set -eu; . "$0"; catch_up', lib], {
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
      FAKE_VERDICT: listing.verdict ?? passedVerdict,
      FAKE_VERDICT_FAILS: listing.verdictFails ? '1' : '',
      ...(listing.retryAfterSeconds === undefined
        ? {}
        : { PG_DRILL_RETRY_AFTER_SECONDS: listing.retryAfterSeconds }),
    },
  })
  const log = existsSync(calls) ? readFileSync(calls, 'utf8') : ''
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    scripts: log.split('\n').filter((line) => line.endsWith('.sh')),
  }
}

/** 每页一行一个对象：`<LastModified>\t<Key>`，和真实 `--query ...[LastModified, Key]` 的输出一致。 */
const freshDrill = `${modifiedAgo(day)}\tapp/pg/drill/latest.json`
const freshDump = `${modifiedAgo(hour / 3)}\tapp/pg/2026-09-18.dump.sha256`

describe('容器启动时补跑备份', () => {
  it('最新一份 dump 已经 30 小时了：补跑一次备份', () => {
    const run = catchUp({
      dump: `${modifiedAgo(30 * hour)}\tapp/pg/2026-09-16.dump`,
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

describe('桶里超过 1000 个对象，aws-cli 分页返回', () => {
  // aws-cli 对每一页单独套 --query；以前 sort_by(...)[-1] 每页出一行，多行被当成「没有备份」，
  // 测试站 pg/ 下 1483 个对象时演练报 no completed dump、每次部署都误补一次备份。
  const pages = [
    `${modifiedAgo(2 * hour)}\tapp/pg/old-a.dump.sha256\n${modifiedAgo(hour / 4)}\tapp/pg/newest.dump.sha256`,
    'None',
    `${modifiedAgo(5 * hour)}\tapp/pg/old-b.dump.sha256\n${modifiedAgo(hour)}\tapp/pg/old-c.dump.sha256`,
  ].join('\n')

  it('newest_object 跨页取最新的一份，忽略没有匹配的页', () => {
    const script = '. "$0"; pg_backup_env; newest_object app/pg/ .dump.sha256'
    const result = spawnSync('sh', ['-c', script, lib], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: `${root}:${process.env.PATH}`,
        CALL_LOG: calls,
        S3_ENDPOINT: 'https://r2.example',
        S3_BUCKET: 'bucket',
        FAKE_DUMP: pages,
      },
    })
    expect(result.status).toBe(0)
    const [key, epoch] = result.stdout.trim().split(' ')
    expect(key).toBe('app/pg/newest.dump.sha256')
    expect(Number(epoch)).toBeGreaterThan(Date.now() / 1000 - hour / 1000 / 2)
  })

  it('最新 dump 在第一页、才 15 分钟：重新部署不误补备份', () => {
    const run = catchUp({ dump: pages, drill: freshDrill })
    expect(run.status).toBe(0)
    expect(run.scripts).toEqual([])
    expect(existsSync(join(root, 'last-success'))).toBe(true)
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
      drill: `${modifiedAgo(9 * day)}\tapp/pg/drill/latest.json`,
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

describe('上一次演练失败：冷却过后容器启动时补跑一次', () => {
  // 2026-10-26 03:00 的周日演练还在用没修过的 newest_object，写下 ok:false「no completed dump under pg/」。
  // 脚本修好后补跑只看年龄（不到 8 天），失败结果一直留到下个周日，告警每小时、每次发版都再报一遍。
  const drillAgo = (ms: number) => `${modifiedAgo(ms)}\tapp/pg/drill/latest.json`

  it('3 天前的演练失败了：补跑一次', () => {
    const run = catchUp({ dump: freshDump, drill: drillAgo(3 * day), verdict: failedVerdict })
    expect(run.status).toBe(0)
    expect(run.scripts).toEqual(['restore-drill.sh'])
    expect(run.output).toContain('latest drill failed')
  })

  it('失败才 1 小时（刚补跑过又失败）：冷却期内不再跑，下一次发版也不会连着跑', () => {
    const run = catchUp({ dump: freshDump, drill: drillAgo(hour), verdict: failedVerdict })
    expect(run.status).toBe(0)
    expect(run.scripts).toEqual([])
    expect(run.output).toContain('retrying after 21600s')
  })

  it('冷却时间可配置：设成 30 分钟后，1 小时前的失败会补跑', () => {
    const run = catchUp({
      dump: freshDump,
      drill: drillAgo(hour),
      verdict: failedVerdict,
      retryAfterSeconds: '1800',
    })
    expect(run.scripts).toEqual(['restore-drill.sh'])
  })

  it('冷却时间配错（不是数字）：按默认 6 小时处理', () => {
    const run = catchUp({
      dump: freshDump,
      drill: drillAgo(hour),
      verdict: failedVerdict,
      retryAfterSeconds: '6h',
    })
    expect(run.status).toBe(0)
    expect(run.scripts).toEqual([])
  })

  it('结果文件读不懂：和 worker 告警一样当失败，冷却过后补跑', () => {
    const run = catchUp({ dump: freshDump, drill: drillAgo(7 * hour), verdict: 'garbage' })
    expect(run.scripts).toEqual(['restore-drill.sh'])
  })

  it('合法 JSON 带空格的通过结果 {"ok": true}：也算通过，不补跑', () => {
    const run = catchUp({
      dump: freshDump,
      drill: drillAgo(3 * day),
      verdict: '{ "ok" : true, "finished_at": "2026-10-25T19:00:11Z", "tables": 3, "rows": 9 }',
    })
    expect(run.scripts).toEqual([])
    expect(run.output).toContain('nothing to do')
  })

  it('只认开头的 ok 字段：失败结果里别处出现 "ok":true 也不当通过', () => {
    const run = catchUp({
      dump: freshDump,
      drill: drillAgo(3 * day),
      verdict: '{"ok":false,"error":"x","detail":{"ok":true}}',
    })
    expect(run.scripts).toEqual(['restore-drill.sh'])
  })

  it('结果文件异常地大（≥4 KB）：只读前 4 KB，不当结果，不跑，交给 cron', () => {
    const run = catchUp({
      dump: freshDump,
      drill: drillAgo(3 * day),
      verdict: `{"ok":false,"error":"${'x'.repeat(5000)}"}`,
    })
    expect(run.status).toBe(0)
    expect(run.scripts).toEqual([])
    expect(run.output).toContain('not a verdict')
  })

  it('上一次演练通过：不管多久（8 天内）都不补跑', () => {
    const run = catchUp({ dump: freshDump, drill: drillAgo(7 * day), verdict: passedVerdict })
    expect(run.scripts).toEqual([])
  })

  it('结果文件下载失败：不知道成败就不跑，留一行日志交给 cron', () => {
    const run = catchUp({
      dump: freshDump,
      drill: drillAgo(3 * day),
      verdict: failedVerdict,
      verdictFails: true,
    })
    expect(run.status).toBe(0)
    expect(run.scripts).toEqual([])
    expect(run.output).toContain('could not read the latest drill verdict')
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
