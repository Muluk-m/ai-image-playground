import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * 部署 workflow 的第一步：只发布 origin/main 的最新提交，且永不回退到线上已有提交的祖先。
 * 每一边各自和自己线上的提交比：两套 API 读 /health，内部站、收费站与 Admin 站读 /version.json。
 * 这里用真实 git 历史与假 curl，只看写进 GITHUB_OUTPUT 的决定。
 */
const script = resolve(__dirname, '../../../../../scripts/ci-deploy-target.sh')
const internalApi = 'https://image-api.example.com'
const paidApi = 'https://api.example.net'
const internalSite = 'https://image.example.com'
const paidSite = 'https://paid.example.net'
const adminSite = 'https://admin.example.net'
const overlay = 'f'.repeat(40)
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

const health = (version: string) => JSON.stringify({ ok: true, version })
/** Pages manifests carry the short public commit, the overlay on the paid build, and the build time. */
const manifest = (commit: string, withOverlay = false) =>
  JSON.stringify({
    version: `${commit.slice(0, 7)}${withOverlay ? `+${overlay.slice(0, 7)}` : ''}-20261017T090303Z`,
    notify: false,
  })

/** Every copy of each side serves the given commit. */
function serveSides({ api, web, admin }: { api: string; web: string; admin: string }) {
  serve({
    [`${internalApi}/health`]: health(api),
    [`${paidApi}/health`]: health(`${api}+${overlay}`),
    [`${internalSite}/version.json`]: manifest(web),
    [`${paidSite}/version.json`]: manifest(web, true),
    [`${adminSite}/version.json`]: manifest(admin, true),
  })
}

const result = (api: boolean, web: boolean, admin: boolean) =>
  `deploy_api=${api}\ndeploy_pages=${web || admin}\ndeploy_web=${web}\ndeploy_admin=${admin}\ndeploy=${api || web || admin}\n`
const nothing = result(false, false, false)
const everything = result(true, true, true)

function decide(target: string, event = 'workflow_run') {
  const output = join(root, 'output')
  writeFileSync(output, '')
  const run = spawnSync('sh', [script, target, event, internalApi, `${paidApi}/`], {
    cwd: repo,
    env: {
      ...env,
      GITHUB_OUTPUT: output,
      WEB_ORIGINS: `${internalSite} ${paidSite}/`,
      ADMIN_ORIGIN: adminSite,
    },
    encoding: 'utf8',
  })
  expect(run.stderr).toBe('')
  expect(run.status).toBe(0)
  return { decision: readFileSync(output, 'utf8'), log: run.stdout }
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
  env = { ...isolatedGitEnv, PATH: `${join(root, 'bin')}:${process.env.PATH}` }
  serve({})
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function commitOnTip(path: string, content: string) {
  const full = join(repo, path)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
  git('add', path)
  git('commit', '-q', '-m', path)
  const sha = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/main', sha)
  return sha
}

describe('ci-deploy-target.sh', () => {
  it('deploys the tip of main over an older release', () => {
    serveSides({ api: commits[1], web: commits[1], admin: commits[1] })
    expect(decide(commits[2]).decision).toBe(everything)
  })

  it('skips a commit that is no longer the tip of main', () => {
    const { decision, log } = decide(commits[1])
    expect(decision).toBe(nothing)
    expect(log).toContain(`::notice::${commits[1]} is not the tip of origin/main (${commits[2]})`)
  })

  it('never moves an API back to an ancestor of what it runs', () => {
    git('update-ref', 'refs/remotes/origin/main', commits[1])
    serve({
      [`${internalApi}/health`]: health(commits[1]),
      [`${paidApi}/health`]: health(`${commits[2]}+${overlay}`),
    })
    const { decision, log } = decide(commits[1])
    expect(decision).toBe(nothing)
    expect(log).toContain(`::notice::${paidApi} already runs ${commits[2]}`)
  })

  it('never moves a site back to an ancestor of what it serves', () => {
    git('update-ref', 'refs/remotes/origin/main', commits[1])
    serveSides({ api: commits[1], web: commits[1], admin: commits[2] })
    const { decision, log } = decide(commits[1])
    expect(decision).toBe(nothing)
    expect(log).toContain(`::notice::${adminSite} already runs ${commits[2]}`)
  })

  it('skips an automatic run when every side already serves the commit, but a manual run redeploys', () => {
    serveSides({ api: commits[2], web: commits[2], admin: commits[2] })
    expect(decide(commits[2]).decision).toBe(nothing)
    expect(decide(commits[2], 'workflow_dispatch').decision).toBe(everything)
  })

  it('ships only the user-facing sites when only the web bundle changed', () => {
    const previous = commits[2]
    const tip = commitOnTip('apps/web/src/main.tsx', 'export {}\n')
    serveSides({ api: previous, web: previous, admin: previous })
    const { decision, log } = decide(tip)
    expect(decision).toBe(result(false, true, false))
    expect(log).toContain(`API tree unchanged since ${previous}`)
    expect(log).toContain(`admin bundle (Admin site) unchanged since ${previous}`)
  })

  it('ships the API when the release receiver changes, so the VPS actually runs the new copy', () => {
    const previous = commits[2]
    const tip = commitOnTip('scripts/vps-deploy.sh', '#!/bin/sh\n')
    serveSides({ api: previous, web: previous, admin: previous })
    const { decision, log } = decide(tip)
    expect(decision).toBe(result(true, false, false))
    expect(log).toContain(`web bundle (internal and paid sites) unchanged since ${previous}`)
  })

  it('ships only the Admin site and the API when the admin app changes', () => {
    const previous = commits[2]
    const tip = commitOnTip('apps/admin/src/main.tsx', 'export {}\n')
    serveSides({ api: previous, web: previous, admin: previous })
    expect(decide(tip).decision).toBe(result(true, false, true))
  })

  it('ships both Pages sides when shared code changes', () => {
    const previous = commits[2]
    const tip = commitOnTip('packages/shared/src/index.ts', 'export {}\n')
    serveSides({ api: previous, web: previous, admin: previous })
    expect(decide(tip).decision).toBe(everything)
  })

  it('ships the API without Pages when only the API tree changed', () => {
    const previous = commits[2]
    const tip = commitOnTip('apps/bff/src/index.ts', 'export {}\n')
    serveSides({ api: previous, web: previous, admin: previous })
    expect(decide(tip).decision).toBe(result(true, false, false))
  })

  it('does not reship the user-facing sites after an earlier run shipped them without the API', () => {
    const before = commits[2]
    const web = commitOnTip('apps/web/src/main.tsx', 'export {}\n')
    const tip = commitOnTip('apps/admin/src/main.tsx', 'export {}\n')
    // The web-only run left the APIs and the Admin site on the older commit.
    serveSides({ api: before, web, admin: before })
    const { decision, log } = decide(tip)
    expect(decision).toBe(result(true, false, true))
    expect(log).toContain(`web bundle (internal and paid sites) unchanged since ${web}`)
  })

  it('still ships the user-facing sites when an earlier run left them behind', () => {
    const before = commits[2]
    commitOnTip('apps/web/src/main.tsx', 'export {}\n')
    const tip = commitOnTip('apps/admin/src/main.tsx', 'export {}\n')
    serveSides({ api: before, web: before, admin: before })
    expect(decide(tip).decision).toBe(everything)
  })

  it('skips every side when the commit changes none of them', () => {
    const previous = commits[2]
    const tip = commitOnTip('docs/note.md', 'note\n')
    serveSides({ api: previous, web: previous, admin: previous })
    const { decision, log } = decide(tip)
    expect(decision).toBe(nothing)
    expect(log).toContain('no web bundle, admin bundle or API changes')
  })

  it('ships a side whose version is missing, unreadable or split between copies', () => {
    const previous = commits[2]
    const tip = commitOnTip('apps/bff/src/index.ts', 'export {}\n')
    serve({
      [`${internalApi}/health`]: health(previous),
      [`${paidApi}/health`]: health(`${previous}+${overlay}`),
      [`${internalSite}/version.json`]: manifest(previous),
      [`${paidSite}/version.json`]: manifest(commits[1], true),
      [`${adminSite}/version.json`]: JSON.stringify({ notify: false }),
    })
    const { decision, log } = decide(tip)
    expect(decision).toBe(everything)
    expect(log).toContain(
      `::warning::${paidSite} runs ${commits[1]} while another copy runs ${previous}`,
    )
    expect(log).toContain(`::warning::${adminSite} reports no commit version`)
  })

  it('deploys when an API does not report a version yet or cannot be reached', () => {
    serve({ [`${internalApi}/health`]: JSON.stringify({ ok: true }) })
    const { decision, log } = decide(commits[2])
    expect(decision).toBe(everything)
    expect(log).toContain(`::warning::${paidApi}/health did not answer`)
    expect(log).toContain(`::warning::${internalApi} reports no commit version`)
  })
})
