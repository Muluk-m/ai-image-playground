import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `scripts/vps-deploy.sh` 每次上线都按提交打一个镜像 tag，从前没人清，tx-vps 的 50G 根分区就是
 * 这样被堆满的。清理规则是一个纯函数：输入是某个形态的镜像 tag（新的在前），输出是该删的那些。
 * 真正的 `docker rmi` 在脚本里，这里只钉规则。
 */
const lib = resolve(__dirname, '../../../../../scripts/lib/deploy-common.sh')

function stale(
  alias: string,
  keep: number,
  tagsNewestFirst: string[],
  protectedTags: string[] = [],
): string[] {
  const out = execFileSync(
    'sh',
    [
      '-c',
      `. "$0"; select_stale_images "$1" "$2" "$3"`,
      lib,
      alias,
      String(keep),
      protectedTags.join(' '),
    ],
    { input: `${tagsNewestFirst.join('\n')}\n`, encoding: 'utf8' },
  )
  return out.split('\n').filter(Boolean)
}

const internal = (sha: string) => `ai-image-playground:vps-main-${sha}`
const paid = (pub: string, priv: string) => `ai-image-playground:paid-${pub}-${priv}`

describe('select_stale_images', () => {
  it('每个形态只留最新的 N 代，其余都该删', () => {
    const tags = ['aaaaaaa1', 'aaaaaaa2', 'aaaaaaa3', 'aaaaaaa4'].map(internal)
    expect(stale('ai-image-playground:vps-main', 2, tags)).toEqual(tags.slice(2))
  })

  it('不够 N 代时什么都不删', () => {
    const tags = ['aaaaaaa1', 'aaaaaaa2'].map(internal)
    expect(stale('ai-image-playground:vps-main', 5, tags)).toEqual([])
  })

  it('正在跑的那一代再旧也不删，也不占保留名额', () => {
    const tags = ['aaaaaaa1', 'aaaaaaa2', 'aaaaaaa3', 'aaaaaaa4'].map(internal)
    expect(stale('ai-image-playground:vps-main', 1, tags, [tags[3]])).toEqual([tags[1], tags[2]])
  })

  it('只认按提交打出来的 tag：移动别名和手工起名的镜像一律不碰', () => {
    const tags = [
      'ai-image-playground:paid',
      paid('aaaaaaa1', 'bbbbbbb1'),
      'ai-image-playground:paid-relay-removal',
      paid('aaaaaaa2', 'bbbbbbb2'),
      'ai-image-playground:pre-reference-paid-354',
      paid('aaaaaaa3', 'bbbbbbb3'),
    ]
    expect(stale('ai-image-playground:paid', 1, tags)).toEqual([
      paid('aaaaaaa2', 'bbbbbbb2'),
      paid('aaaaaaa3', 'bbbbbbb3'),
    ])
  })

  it('抠图服务按自己的版本打 tag（segmenter-<版本>-<sha>），也照样只留最新的 N 代', () => {
    const seg = (v: number, sha: string) => `ai-image-playground:segmenter-${v}-${sha}`
    const tags = [
      'ai-image-playground:segmenter',
      seg(2, 'aaaaaaaaaaa4'),
      seg(1, 'aaaaaaaaaaa3'),
      'ai-image-playground:segmenter-test',
      seg(1, 'aaaaaaaaaaa2'),
      seg(1, 'aaaaaaaaaaa1'),
    ]
    expect(stale('ai-image-playground:segmenter', 2, tags, [seg(1, 'aaaaaaaaaaa1')])).toEqual([
      seg(1, 'aaaaaaaaaaa2'),
    ])
    // 别的形态不认这种形状，免得把 <alias>-<数字>-<sha> 的手工 tag 当成发布产物。
    expect(
      stale('ai-image-playground:vps-main', 0, ['ai-image-playground:vps-main-1-aaaaaaa1']),
    ).toEqual([])
  })

  it('两个形态共用仓库名时互不误删', () => {
    const tags = [internal('aaaaaaa1'), paid('aaaaaaa1', 'bbbbbbb1'), internal('aaaaaaa2')]
    expect(stale('ai-image-playground:vps-main', 1, tags)).toEqual([internal('aaaaaaa2')])
  })
})

/**
 * 镜像是按 digest 拉下来的，删掉本地 tag 之后还剩一条 `<registry>@sha256:...` 引用钉着快照。
 * 生产就是这样把 50G 根分区堆到 84%、把发布卡在空间预检上的：`docker images` 看着只有几代，
 * 底下压着 24 个只剩 digest 名字的旧代。注意 docker 把那条 registry 引用也算进镜像的名字里，
 * 所以"还剩几个名字"永远不为零，判据只能看本地仓库名还在不在。
 */
function releaseUntagged(names: string[] | 'missing') {
  const dir = mkdtempSync(join(tmpdir(), 'aip-release-untagged-'))
  const calls = join(dir, 'calls')
  const inspect =
    names === 'missing' ? 'exit 1' : `printf '%s\\n' ${names.map((n) => `'${n}'`).join(' ')}`
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\ncase "$1 $2" in\n  'image inspect') ${inspect} ;;\n  'rmi '*) : ;;\nesac\n`,
  )
  chmodSync(join(dir, 'docker'), 0o755)
  const out = execFileSync(
    'sh',
    ['-c', `. "$0"; release_untagged_image "$1" "$2"`, lib, 'sha256:abc', 'ai-image-playground'],
    { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
  )
  const log = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []
  return { out: out.trim(), removed: log.some((line) => line.startsWith('rmi ')) }
}

const registryRef = 'ghcr.io/muluk-m/ai-image-playground@sha256:abc'

describe('release_untagged_image', () => {
  it('本地名字没了就把 registry 引用一起删掉，层才真的回收', () => {
    const result = releaseUntagged([registryRef])
    expect(result.removed).toBe(true)
    expect(result.out).toContain('sha256:abc')
  })

  it('还有本地 tag 指着它就不碰：那是另一代的回滚目标', () => {
    expect(releaseUntagged(['ai-image-playground:vps-main-aaaaaaa1', registryRef]).removed).toBe(
      false,
    )
  })

  it('移动别名还指着它也不碰', () => {
    expect(releaseUntagged(['ai-image-playground:vps-main', registryRef]).removed).toBe(false)
  })

  it('镜像已经不在了也不报错', () => {
    expect(releaseUntagged('missing')).toEqual({ out: '', removed: false })
  })
})

describe('reclaim_deploy_disk', () => {
  it('删掉超出保留代的镜像和悬空层，并清掉已发布与失败发布的镜像归档', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aip-reclaim-'))
    const bin = join(dir, 'bin')
    const config = join(dir, 'config')
    const releases = join(dir, 'releases')
    const current = join(releases, 'aip-current')
    const deployed = join(releases, 'aip-deployed')
    const pending = join(releases, 'aip-pending')
    const failed = join(releases, 'aip-old.failed-run-9')
    mkdirSync(bin)
    mkdirSync(join(config, 'ai-image-playground'), { recursive: true })
    for (const path of [current, deployed, pending, failed]) mkdirSync(path, { recursive: true })
    writeFileSync(join(current, 'images.tar.gz'), 'current')
    writeFileSync(join(deployed, 'images.tar.gz'), 'deployed')
    writeFileSync(join(pending, 'images.tar.gz'), 'pending')
    writeFileSync(join(failed, 'images.tar.gz'), 'failed')
    const kept = 'ai-image-playground:vps-main-aaaaaaaaaaaa'
    writeFileSync(
      join(deployed, 'images.tsv'),
      `internal\t${kept}\tsha256:${'a'.repeat(64)}\t${'b'.repeat(40)}\t-\n`,
    )
    writeFileSync(
      join(current, 'images.tsv'),
      `internal\t${kept}\tsha256:${'a'.repeat(64)}\t${'b'.repeat(40)}\t-\n`,
    )
    writeFileSync(
      join(config, 'ai-image-playground/deployments.log'),
      `2026-10-14T00:00:00Z internal public=${'b'.repeat(40)} private=- image=${kept} by=test result=ok\n`,
    )
    const calls = join(dir, 'calls')
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
case "$1 $2" in
  'image prune')
    case " $* " in
      *' -a '*|*' --all '*) echo "refusing to drop tagged rollback images" >&2; exit 1 ;;
    esac
    ;;
  'image inspect')
    case "$3" in
      sha256:dead) printf '%s\\n' 'ghcr.io/muluk-m/ai-image-playground@sha256:dead' ;;
      *) printf '%s\\n' 'sha256:dead' ;;
    esac
    ;;
  'images --format')
    printf '%s\\n' \\
      'ai-image-playground:vps-main-aaaaaaa1' \\
      'ai-image-playground:vps-main-aaaaaaa2' \\
      'ai-image-playground:vps-main-aaaaaaa3' \\
      'ai-image-playground:paid-relay-removal'
    ;;
esac
`,
    )
    chmodSync(join(bin, 'docker'), 0o755)
    const out = execFileSync(
      'sh',
      ['-c', 'set -eu; . "$0"; reclaim_deploy_disk "$1"', lib, current],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          XDG_CONFIG_HOME: config,
          DEPLOY_KEEP_IMAGES: '2',
        },
      },
    )
    const log = readFileSync(calls, 'utf8')
    expect(out).toContain('pruned ai-image-playground:vps-main-aaaaaaa3')
    expect(out).not.toContain('pruned ai-image-playground:paid-relay-removal')
    expect(log).toContain('rmi ai-image-playground:vps-main-aaaaaaa3')
    expect(log).toContain('rmi sha256:dead')
    expect(log).toContain('image prune -f')
    expect(log).not.toContain('image prune -a')
    expect(existsSync(join(current, 'images.tar.gz'))).toBe(true)
    expect(existsSync(join(deployed, 'images.tar.gz'))).toBe(false)
    expect(existsSync(join(pending, 'images.tar.gz'))).toBe(true)
    expect(existsSync(join(failed, 'images.tar.gz'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('重试失败目录时留下自己的归档，并留下这次即将部署的旧标签', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aip-reclaim-'))
    const bin = join(dir, 'bin')
    const releases = join(dir, 'releases')
    const current = join(releases, 'aip-retry.failed-run-9')
    const other = join(releases, 'aip-other.failed-run-8')
    mkdirSync(bin)
    mkdirSync(current, { recursive: true })
    mkdirSync(other, { recursive: true })
    writeFileSync(join(current, 'images.tar.gz'), 'current')
    writeFileSync(join(other, 'images.tar.gz'), 'other')
    const calls = join(dir, 'calls')
    writeFileSync(
      join(bin, 'docker'),
      `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$1 $2" in
  'image prune'|'builder prune') ;;
  'images --format')
    printf '%s\\n' \\
      'ai-image-playground:vps-main-aaaaaaa1' \\
      'ai-image-playground:vps-main-aaaaaaa2' \\
      'ai-image-playground:vps-main-aaaaaaa3'
    ;;
esac
`,
    )
    chmodSync(join(bin, 'docker'), 0o755)
    const out = execFileSync(
      'sh',
      [
        '-c',
        'set -eu; . "$0"; reclaim_deploy_disk "$1" "ai-image-playground:vps-main-aaaaaaa3"',
        lib,
        current,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          XDG_CONFIG_HOME: join(dir, 'config'),
          DEPLOY_KEEP_IMAGES: '2',
        },
      },
    )
    const log = readFileSync(calls, 'utf8')
    expect(out).not.toContain('pruned ai-image-playground:vps-main-aaaaaaa3')
    expect(log).not.toContain('rmi ')
    expect(existsSync(join(current, 'images.tar.gz'))).toBe(true)
    expect(existsSync(join(other, 'images.tar.gz'))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('拉镜像之前就回收，测试发布也会清备份镜像', () => {
    const receiver = readFileSync(
      resolve(__dirname, '../../../../../scripts/vps-deploy.sh'),
      'utf8',
    )
    const reclaim = receiver.indexOf('reclaim_deploy_disk "$release" "$release_images"')
    const free = receiver.indexOf('free_gb=$(docker_root_free_gb)')
    const tighter = receiver.indexOf('reclaim_deploy_disk "$release" "$release_images" 1')
    expect(reclaim).toBeGreaterThan(-1)
    expect(free).toBeGreaterThan(reclaim)
    expect(tighter).toBeGreaterThan(free)
    expect(receiver).toContain('reclaim_deploy_disk "$release" "$rolled_out $backup_image"')
    expect(receiver).not.toContain('prune_old_images')
  })
})

/**
 * 发布目录里的镜像归档，只有其中每个应用镜像都在部署日志里 ok 过才删。备份 sidecar 和共享抠图服务
 * 跟着各形态一起上，不单独记日志；要是把它们也算进去，带抠图服务的生产发布就永远删不掉归档。
 */
describe('release_was_deployed', () => {
  function deployed(rows: string[], logLines: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'aip-release-deployed-'))
    try {
      const release = join(dir, 'release')
      mkdirSync(release)
      writeFileSync(join(release, 'images.tsv'), `${rows.join('\n')}\n`)
      const log = join(dir, 'deployments.log')
      writeFileSync(log, logLines.map((line) => `${line}\n`).join(''))
      return execFileSync(
        'sh',
        [
          '-c',
          `. "$0"; deployments_log=$2; release_was_deployed "$1" && echo yes || echo no`,
          lib,
          release,
          log,
        ],
        { encoding: 'utf8' },
      ).trim()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const ok = (image: string) =>
    `2026-10-23T00:00:00Z internal public=a private=- image=${image} by=ci result=ok`

  it('不等抠图服务和备份的日志行，它们本来就没有', () => {
    const rows = [
      'internal\tai-image-playground:vps-main-aaaaaaa1\tsha256:1\ta\t-',
      'backup\tai-image-playground:backup-aaaaaaa1\tsha256:2\ta\t-',
      'segmenter\tai-image-playground:segmenter-1-aaaaaaa1\tsha256:3\ta\t-',
    ]
    expect(deployed(rows, [ok('ai-image-playground:vps-main-aaaaaaa1')])).toBe('yes')
  })

  it('应用镜像没上成功就保留归档', () => {
    const rows = [
      'internal\tai-image-playground:vps-main-aaaaaaa1\tsha256:1\ta\t-',
      'segmenter\tai-image-playground:segmenter-1-aaaaaaa1\tsha256:3\ta\t-',
    ]
    expect(deployed(rows, [])).toBe('no')
  })

  it('只带抠图服务、没有应用镜像的目录不算上过', () => {
    expect(
      deployed(['segmenter\tai-image-playground:segmenter-1-aaaaaaa1\tsha256:3\ta\t-'], []),
    ).toBe('no')
  })
})
