import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 每个发布目录都带着约 1 GB 的镜像包，而它在 `docker load` 之后就只是副本了。
 * 一天发几次版，VPS 的磁盘就被它们占掉五分之一。部署成功后清掉已经部署过的那些；
 * 还没部署的（比如别人正在传进来的）一个字节都不能碰。
 */
const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

const common = resolve(import.meta.dir, '../../../../../scripts/lib/deploy-common.sh')

async function release(root: string, name: string, images: string[]): Promise<string> {
  const dir = join(root, 'releases', name)
  await mkdir(join(dir, 'scripts'), { recursive: true })
  await writeFile(join(dir, 'images.tar.gz'), 'archive')
  await writeFile(join(dir, 'scripts/vps-deploy.sh'), '#!/bin/sh\n')
  const lines = images.map(
    (image, i) => `${i === 0 ? 'internal' : 'paid'}\t${image}\tsha256:x\ta\t-`,
  )
  lines.push(`backup\tai-image-playground:backup-${name}\tsha256:y\ta\t-`)
  await writeFile(join(dir, 'images.tsv'), `${lines.join('\n')}\n`)
  return dir
}

function logLine(image: string, result: 'ok' | 'failed'): string {
  return `2026-09-18T05:31:45Z paid public=a private=b image=${image} by=ubuntu@vps result=${result}`
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  )
}

describe('prune_old_releases', () => {
  it('drops the archives of releases that went out, and nothing else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aip-releases-'))
    temporary.push(root)
    const xdg = join(root, 'xdg')
    await mkdir(join(xdg, 'ai-image-playground'), { recursive: true })

    const deployed = await release(root, 'aip-old', [
      'ai-image-playground:vps-main-old',
      'ai-image-playground:paid-old',
    ])
    const failed = await release(root, 'aip-failed', ['ai-image-playground:vps-main-bad'])
    const incoming = await release(root, 'aip-incoming', ['ai-image-playground:vps-main-next'])
    const current = await release(root, 'aip-current', ['ai-image-playground:vps-main-now'])
    await writeFile(join(root, 'releases', 'aip-old.transport.tar'), 'tar')
    await writeFile(join(root, 'releases', 'aip-incoming.transport.tar'), 'tar')
    await writeFile(
      join(xdg, 'ai-image-playground', 'deployments.log'),
      [
        logLine('ai-image-playground:vps-main-old', 'ok'),
        logLine('ai-image-playground:paid-old', 'ok'),
        logLine('ai-image-playground:vps-main-bad', 'failed'),
        logLine('ai-image-playground:vps-main-now', 'ok'),
        '',
      ].join('\n'),
    )

    const proc = Bun.spawn(['sh', '-c', `. "${common}" && prune_old_releases "${current}"`], {
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: xdg },
      stdout: 'pipe',
    })
    expect(await proc.exited).toBe(0)

    // 部署过的：镜像包与传输包都清掉，脚本留着给回滚用。
    expect(await exists(join(deployed, 'images.tar.gz'))).toBe(false)
    expect(await exists(join(deployed, 'scripts/vps-deploy.sh'))).toBe(true)
    expect(await exists(join(root, 'releases', 'aip-old.transport.tar'))).toBe(false)
    // 部署失败过、还没部署、以及刚发的这一个：一个字节都不动。
    expect(await exists(join(failed, 'images.tar.gz'))).toBe(true)
    expect(await exists(join(incoming, 'images.tar.gz'))).toBe(true)
    expect(await exists(join(root, 'releases', 'aip-incoming.transport.tar'))).toBe(true)
    expect(await exists(join(current, 'images.tar.gz'))).toBe(true)
    expect((await readdir(join(root, 'releases'))).sort()).toEqual([
      'aip-current',
      'aip-failed',
      'aip-incoming',
      'aip-incoming.transport.tar',
      'aip-old',
    ])
  })

  it('keeps an archive when only one of its editions went out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aip-releases-'))
    temporary.push(root)
    const xdg = join(root, 'xdg')
    await mkdir(join(xdg, 'ai-image-playground'), { recursive: true })
    const half = await release(root, 'aip-half', [
      'ai-image-playground:vps-main-h',
      'ai-image-playground:paid-h',
    ])
    const current = await release(root, 'aip-current', ['ai-image-playground:vps-main-now'])
    await writeFile(
      join(xdg, 'ai-image-playground', 'deployments.log'),
      `${logLine('ai-image-playground:vps-main-h', 'ok')}\n`,
    )

    const proc = Bun.spawn(['sh', '-c', `. "${common}" && prune_old_releases "${current}"`], {
      env: { PATH: process.env.PATH, HOME: root, XDG_CONFIG_HOME: xdg },
    })
    expect(await proc.exited).toBe(0)
    expect(await exists(join(half, 'images.tar.gz'))).toBe(true)
  })
})
