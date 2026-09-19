import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

  it('两个形态共用仓库名时互不误删', () => {
    const tags = [internal('aaaaaaa1'), paid('aaaaaaa1', 'bbbbbbb1'), internal('aaaaaaa2')]
    expect(stale('ai-image-playground:vps-main', 1, tags)).toEqual([internal('aaaaaaa2')])
  })
})

/**
 * 镜像是按 digest 拉下来的，删掉本地 tag 之后还剩一条 `<registry>@sha256:...` 引用钉着快照。
 * 生产就是这样把 50G 根分区堆到 84%、把发布卡在空间预检上的：`docker images` 看着只有几代。
 * 这里用假 docker 钉住"没有 tag 了就连带把 digest 引用删掉，还有 tag 的不许碰"。
 */
function releaseUntagged(imageId: string, repoTags: number | 'missing') {
  const dir = mkdtempSync(join(tmpdir(), 'aip-release-untagged-'))
  const calls = join(dir, 'calls')
  const inspect =
    repoTags === 'missing' ? 'exit 1' : `[ "$1" = "image" ] && printf '%s' ${repoTags}`
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${calls}"\ncase "$1 $2" in\n  'image inspect') ${inspect}; exit 0 ;;\n  'rmi '*) exit 0 ;;\nesac\nexit 0\n`,
  )
  chmodSync(join(dir, 'docker'), 0o755)
  const out = execFileSync('sh', ['-c', `. "$0"; release_untagged_image "$1"`, lib, imageId], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  })
  const log = existsSync(calls) ? readFileSync(calls, 'utf8').split('\n').filter(Boolean) : []
  return { out: out.trim(), removed: log.some((line) => line.startsWith('rmi ')) }
}

describe('release_untagged_image', () => {
  it('最后一个 tag 没了就把 digest 引用一起删掉，层才真的回收', () => {
    const result = releaseUntagged('sha256:abc', 0)
    expect(result.removed).toBe(true)
    expect(result.out).toContain('sha256:abc')
  })

  it('还有别的 tag 指着它就不碰：那是另一代的回滚目标', () => {
    expect(releaseUntagged('sha256:abc', 1).removed).toBe(false)
  })

  it('镜像已经不在了也不报错', () => {
    expect(releaseUntagged('sha256:gone', 'missing')).toEqual({ out: '', removed: false })
  })
})
