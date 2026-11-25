import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 发布脚本消费的是 `config render` 的真实输出：这里用假密钥把仓库里的 prod、test 部署描述真渲染一遍，
 * 按 VPS 的目录结构摆好，再跑 test 发布前的隔离检查。描述、清单或检查脚本任何一边改动让它们对不上
 * （比如按服务不同的 APP_ROLE 被当成冲突），这里先失败，而不是等 test 发布失败。
 */
const repo = resolve(import.meta.dir, '../../../../..')
let root = ''
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: repo, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

/** Renders a deployment with fixture secrets into <config>/rendered/<project>. */
function render(deployment: 'prod' | 'test', project: string, secrets?: (text: string) => string) {
  let text = run('bun', ['run', 'scripts/deploy-fixture-secrets.ts', deployment])
  if (secrets) text = secrets(text)
  const file = join(root, `${deployment}.secrets`)
  writeFileSync(file, text)
  const out = join(root, 'config', 'rendered', project)
  run('bun', [
    'run',
    'apps/bff/src/deploy-config-cli.ts',
    'render',
    deployment,
    '--out',
    out,
    '--secrets-file',
    file,
  ])
  return out
}

const isolation = (dir: string) =>
  spawnSync('sh', [join(repo, 'scripts/check-test-isolation.sh'), 'runtime', dir], {
    encoding: 'utf8',
  })

describe('rendered deployments pass the test isolation check', () => {
  it('accepts the rendered test deployment against the rendered production one', () => {
    root = mkdtempSync(join(tmpdir(), 'aip-rendered-isolation-'))
    render('prod', 'image-playground-paid')
    const test = render('test', 'image-playground-test')
    const result = isolation(test)
    expect(result.status, result.stderr).toBe(0)
  })

  it('refuses a test render that reuses a production secret', () => {
    root = mkdtempSync(join(tmpdir(), 'aip-rendered-isolation-'))
    render('prod', 'image-playground-paid')
    const prodSecrets = readFileSync(join(root, 'prod.secrets'), 'utf8')
    const prodToken = /^INTERNAL_API_TOKEN=(.*)$/m.exec(prodSecrets)?.[1]
    expect(prodToken).toBeDefined()
    const test = render('test', 'image-playground-test', (text) =>
      text.replace(/^INTERNAL_API_TOKEN=.*$/m, `INTERNAL_API_TOKEN=${prodToken}`),
    )
    const result = isolation(test)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('INTERNAL_API_TOKEN reuses a production credential')
  })

  it('accepts the rendered test deployment against a production still on app.env', () => {
    root = mkdtempSync(join(tmpdir(), 'aip-rendered-isolation-'))
    const prod = render('prod', 'image-playground-paid')
    // Production on app.env: the same values, one file, where the legacy layout keeps them.
    const legacy = join(root, 'config', 'apps', 'image-playground-paid')
    mkdirSync(legacy, { recursive: true })
    const merged = ['bff', 'admin']
      .map((service) => readFileSync(join(prod, 'env', `${service}.env`), 'utf8'))
      .join('')
    writeFileSync(join(legacy, 'app.env'), merged)
    rmSync(prod, { recursive: true, force: true })
    const test = render('test', 'image-playground-test')
    const result = isolation(test)
    expect(result.status, result.stderr).toBe(0)
  })
})
