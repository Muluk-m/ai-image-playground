import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
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
