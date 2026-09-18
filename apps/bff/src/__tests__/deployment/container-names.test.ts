import { afterEach, describe, expect, it } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 运维看板的采集容器只认 cgroup 里的容器 ID，名字靠部署脚本写的对照表。
 * 发布流程有两条入口会起容器：首次部署走 `up`，之后的发布经 `compose … up` 起 admin 与采集容器。
 * 两条都得把表写好，而且写在一个目录里——单文件挂载时 Docker 会把缺席的源建成 root 的目录。
 */
const temporary: string[] = []
afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aip-names-'))
  temporary.push(root)
  const bin = join(root, 'bin')
  const xdg = join(root, 'xdg')
  const env = join(root, 'app.env')
  await mkdir(bin)
  await writeFile(env, '')
  await writeFile(
    join(bin, 'docker'),
    `#!/bin/sh
case "$1" in
  ps) printf 'aaaa\\timage-playground-paid-admin-1\\nbbbb\\timage-playground-paid-r1-bff\\n' ;;
  compose) printf '%s\\n' "$*" >> "$MOCK_LOG" ;;
esac
`,
  )
  await chmod(join(bin, 'docker'), 0o755)
  return { root, bin, xdg, env }
}

async function run(
  f: Awaited<ReturnType<typeof fixture>>,
  args: string[],
): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(
    ['sh', resolve(import.meta.dir, '../../../../../scripts/app-compose.sh'), ...args],
    {
      env: {
        PATH: `${f.bin}:${process.env.PATH}`,
        HOME: f.root,
        XDG_CONFIG_HOME: f.xdg,
        APP_ENV_FILE: f.env,
        MOCK_LOG: join(f.root, 'compose.log'),
      },
      stderr: 'pipe',
    },
  )
  const code = await proc.exited
  return { code, stderr: await new Response(proc.stderr).text() }
}

describe('container-name table for the operations board', () => {
  it('is written after a release starts containers through `compose … up`', async () => {
    const f = await fixture()

    const result = await run(f, ['compose', 'paid', 'up', '--detach', '--no-deps', 'admin'])

    expect(result.code).toBe(0)
    const table = await readFile(
      join(f.xdg, 'ai-image-playground/ops-board/container-names.tsv'),
      'utf8',
    )
    expect(table).toBe('aaaa\timage-playground-paid-admin-1\nbbbb\timage-playground-paid-r1-bff\n')
  })

  it('leaves the table alone for compose commands that start nothing', async () => {
    const f = await fixture()

    await run(f, ['compose', 'paid', 'ps'])

    await expect(
      stat(join(f.xdg, 'ai-image-playground/ops-board/container-names.tsv')),
    ).rejects.toThrow()
    // 目录本身总是先建好，Docker 才不会替我们建一个 root 所有的。
    expect((await stat(join(f.xdg, 'ai-image-playground/ops-board'))).isDirectory()).toBe(true)
  })

  it('clears the empty directory an earlier single-file mount left behind', async () => {
    const f = await fixture()
    await mkdir(join(f.xdg, 'ai-image-playground/container-names.tsv'), { recursive: true })

    await run(f, ['compose', 'paid', 'ps'])

    await expect(stat(join(f.xdg, 'ai-image-playground/container-names.tsv'))).rejects.toThrow()
  })
})
