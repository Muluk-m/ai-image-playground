import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * 部署 workflow 的第一步：只发布 origin/main 的最新提交，且永不回退到线上已有提交的祖先。
 * 线上版本从两套 API 的 /health 读取。这里用真实 git 历史与假 curl，只看写进 GITHUB_OUTPUT 的决定。
 */
const script = resolve(__dirname, '../../../../../scripts/ci-deploy-target.sh')
const internalApi = 'https://image-api.example.com'
const paidApi = 'https://api.example.net'
let root: string
let repo: string
let commits: string[]
let env: NodeJS.ProcessEnv

function git(...args: string[]) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-C', repo, ...args],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

/** What each API's /health answers; a missing entry means the request fails. */
function serve(bodies: Record<string, string>) {
  const lines = Object.entries(bodies)
    .map(([url, body]) => `  '${url}/health') printf '%s' '${body}' ;;`)
    .join('\n')
  writeFileSync(
    join(root, 'bin/curl'),
    `#!/bin/sh\nfor url; do :; done\ncase "$url" in\n${lines}\n  *) exit 22 ;;\nesac\n`,
  )
  chmodSync(join(root, 'bin/curl'), 0o755)
}

const health = (version: string) => JSON.stringify({ ok: true, version })

function decide(target: string, event = 'workflow_run') {
  const output = join(root, 'output')
  writeFileSync(output, '')
  const result = spawnSync('sh', [script, target, event, internalApi, `${paidApi}/`], {
    cwd: repo,
    env: { ...env, GITHUB_OUTPUT: output },
    encoding: 'utf8',
  })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  return { decision: readFileSync(output, 'utf8'), log: result.stdout }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aip-deploy-target-'))
  repo = join(root, 'repo')
  mkdirSync(repo)
  mkdirSync(join(root, 'bin'))
  git('init', '-q')
  commits = []
  for (const n of [1, 2, 3]) {
    git('commit', '-q', '--allow-empty', '-m', `c${n}`)
    commits.push(git('rev-parse', 'HEAD'))
  }
  git('update-ref', 'refs/remotes/origin/main', commits[2])
  env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` }
  serve({})
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('ci-deploy-target.sh', () => {
  it('deploys the tip of main over an older release', () => {
    serve({
      [internalApi]: health(commits[1]),
      [paidApi]: health(`${commits[1]}+${'f'.repeat(40)}`),
    })
    expect(decide(commits[2]).decision).toBe('deploy=true\n')
  })

  it('skips a commit that is no longer the tip of main', () => {
    const { decision, log } = decide(commits[1])
    expect(decision).toBe('deploy=false\n')
    expect(log).toContain(`::notice::${commits[1]} is not the tip of origin/main (${commits[2]})`)
  })

  it('never moves an API back to an ancestor of what it runs', () => {
    git('update-ref', 'refs/remotes/origin/main', commits[1])
    serve({
      [internalApi]: health(commits[1]),
      [paidApi]: health(`${commits[2]}+${'f'.repeat(40)}`),
    })
    const { decision, log } = decide(commits[1])
    expect(decision).toBe('deploy=false\n')
    expect(log).toContain(`::notice::${paidApi} already runs ${commits[2]}`)
  })

  it('skips an automatic run when both APIs already serve the commit, but a manual run redeploys', () => {
    serve({
      [internalApi]: health(commits[2]),
      [paidApi]: health(`${commits[2]}+${'f'.repeat(40)}`),
    })
    expect(decide(commits[2]).decision).toBe('deploy=false\n')
    expect(decide(commits[2], 'workflow_dispatch').decision).toBe('deploy=true\n')
  })

  it('deploys when an API does not report a version yet or cannot be reached', () => {
    serve({ [internalApi]: JSON.stringify({ ok: true }) })
    const { decision, log } = decide(commits[2])
    expect(decision).toBe('deploy=true\n')
    expect(log).toContain(`::warning::${paidApi}/health did not answer`)
    expect(log).toContain(`::warning::${internalApi} reports no commit version`)
  })
})
