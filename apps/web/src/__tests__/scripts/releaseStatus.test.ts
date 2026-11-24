import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** 发布前的只读清单：每一边线上跑的提交到目标提交之间还差哪些。真实 git 历史 + 假 curl。 */
const script = resolve(__dirname, '../../../../../scripts/release-status.sh')
const api = 'https://api.example.net'
const web = 'https://web.example.net'
const admin = 'https://admin.example.net'
let root: string
let repo: string
let commits: string[]
let env: NodeJS.ProcessEnv

const isolatedGitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
}

function git(...args: string[]) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-C', repo, ...args],
    { encoding: 'utf8', env: isolatedGitEnv },
  )
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

/** What each endpoint answers; a missing entry means the request fails. */
function serve(bodies: Record<string, string>) {
  const lines = Object.entries(bodies)
    .map(([url, body]) => `  '${url}') printf '%s' '${body}' ;;`)
    .join('\n')
  writeFileSync(
    join(root, 'bin/curl'),
    `#!/bin/sh\nfor url; do :; done\ncase "$url" in\n${lines}\n  *) exit 22 ;;\nesac\n`,
  )
  chmodSync(join(root, 'bin/curl'), 0o755)
}

const health = (commit: string) => JSON.stringify({ ok: true, version: `${commit}+${commit}` })
const site = (version: string) => JSON.stringify({ version, notify: false })

function status() {
  const run = spawnSync('sh', [script], { cwd: repo, env, encoding: 'utf8' })
  expect(run.stderr).toBe('')
  expect(run.status).toBe(0)
  return run.stdout
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aip-release-status-'))
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
  env = {
    ...isolatedGitEnv,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    PAGES_ENV_FILE: join(root, 'missing.env'),
    RELEASE_STATUS_FETCH: '0',
    RELEASE_API: api,
    RELEASE_WEB: web,
    RELEASE_ADMIN: admin,
  }
  serve({})
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('release-status.sh', () => {
  it('lists the commits each side still lacks, and says when a side is current', () => {
    serve({
      [`${api}/health`]: health(commits[0]),
      [`${web}/version.json`]: site(`${commits[2].slice(0, 7)}-20261124T024019Z`),
      [`${admin}/version.json`]: site(`${commits[1].slice(0, 7)}-20261124T024330Z`),
    })
    const out = status()
    expect(out).toContain('API: serves')
    expect(out).toContain('2 commit(s) to ship:')
    expect(out).toContain(`muvloom 前端: up to date (${commits[2].slice(0, 7)})`)
    expect(out).toMatch(/Admin: serves \w+; 1 commit\(s\) to ship:\n {2}- \w+ c3/)
  })

  it('does not read a build-time-only version as a commit', () => {
    serve({ [`${web}/version.json`]: site('20261124T024019Z') })
    expect(status()).toContain(
      "muvloom 前端: serves '20261124T024019Z', not a commit in this history",
    )
  })

  it('flags a side that serves something off the target history', () => {
    git('checkout', '-q', '-b', 'side', commits[0])
    git('commit', '-q', '--allow-empty', '-m', 'side')
    const side = git('rev-parse', 'HEAD')
    serve({ [`${api}/health`]: health(side) })
    expect(status()).toContain('which is not an ancestor of the target')
  })

  it('reports an endpoint that does not answer', () => {
    expect(status()).toContain(`Admin: ${admin}/version.json did not answer`)
  })
})
