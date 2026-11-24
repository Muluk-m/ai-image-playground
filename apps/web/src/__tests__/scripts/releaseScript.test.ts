import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** 幂等生产发布入口 scripts/release.sh 测试：已在线跳过、搭便车复用、等 CI 后单次派发。 */
const script = resolve(__dirname, '../../../../../scripts/release.sh')
const repoSlug = 'Muluk-m/ai-image-playground'
const api = 'https://api.example.net'
const web = 'https://web.example.net'
const admin = 'https://admin.example.net'

let root: string
let repo: string
let commits: string[]
let env: NodeJS.ProcessEnv
let ghLogFile: string

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

const health = (commit: string) => JSON.stringify({ ok: true, version: `${commit}+${commit}` })
const site = (commit: string) =>
  JSON.stringify({ version: `${commit.slice(0, 7)}-20261124T024019Z`, notify: false })

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

type GhApiSequence = Record<string, Array<Record<string, unknown>>>

/**
 * Fake `gh`:
 * - `gh api <endpoint> --jq <expr>`: pops next queued response (or repeats the last one) and runs real `jq`.
 * - `gh workflow run ...`: logs args and optionally pushes a new dispatched run into the API queue.
 * - `gh run watch ...`: logs args and exits 0.
 */
function mockGh(
  apiResponses: GhApiSequence,
  options?: { dispatchedRun?: { id: number; html_url: string } },
) {
  const stateFile = join(root, 'gh-api-state.json')
  writeFileSync(stateFile, JSON.stringify({ responses: apiResponses, counts: {} }))
  const dispatchedJson = options?.dispatchedRun ? JSON.stringify(options.dispatchedRun) : ''
  writeFileSync(
    join(root, 'bin/gh'),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> '${ghLogFile}'
case "$1" in
  api)
    shift
    endpoint=$1
    shift
    jq_expr=.
    while [ "$#" -gt 0 ]; do
      case $1 in
        --jq) jq_expr=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    idx=$(jq -r --arg key "$endpoint" '.counts[$key] // 0' '${stateFile}')
    payload=$(jq -c --arg key "$endpoint" --argjson i "$idx" '
      (.responses[$key] // [{workflow_runs: []}]) as $arr |
      if ($arr | length) == 0 then {workflow_runs: []}
      elif $i < ($arr | length) then $arr[$i]
      else $arr[-1] end
    ' '${stateFile}')
    tmp=$(mktemp '${root}/gh-state.XXXXXX')
    jq --arg key "$endpoint" --argjson next "$((idx + 1))" '.counts[$key] = $next' '${stateFile}' >"$tmp"
    mv "$tmp" '${stateFile}'
    printf '%s' "$payload" | jq -r "$jq_expr"
    ;;
  workflow)
    if [ -n '${dispatchedJson}' ]; then
      tmp=$(mktemp '${root}/gh-state.XXXXXX')
      jq --arg key 'repos/${repoSlug}/actions/workflows/deploy.yml/runs?event=workflow_dispatch&branch=main&per_page=10' \
         --argjson run '${dispatchedJson || 'null'}' \
         '.responses[$key] = [{workflow_runs: [$run]}]' '${stateFile}' >"$tmp"
      mv "$tmp" '${stateFile}'
    fi
    exit 0
    ;;
  run)
    exit 0
    ;;
  *)
    echo "unexpected gh args: $*" >&2
    exit 2
    ;;
esac
`,
  )
  chmodSync(join(root, 'bin/gh'), 0o755)
}

function runRelease(...args: string[]) {
  return spawnSync('sh', [script, ...args], { cwd: repo, env, encoding: 'utf8' })
}

function ghCalls() {
  try {
    return readFileSync(ghLogFile, 'utf8').trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aip-release-sh-'))
  repo = join(root, 'repo')
  ghLogFile = join(root, 'gh.log')
  mkdirSync(repo)
  mkdirSync(join(root, 'bin'))
  git('init', '-q')
  commits = []
  // c0: baseline (api+web+admin), c1: web only, c2: api only
  for (const [n, files] of [
    [0, ['apps/bff/a.ts', 'apps/web/b.ts', 'apps/admin/c.ts']],
    [1, ['apps/web/b.ts']],
    [2, ['apps/bff/a.ts']],
  ] as const) {
    for (const file of files) {
      mkdirSync(join(repo, file, '..'), { recursive: true })
      writeFileSync(join(repo, file), `${n}\n`)
      git('add', file)
    }
    git('commit', '-q', '-m', `c${n}`)
    commits.push(git('rev-parse', 'HEAD'))
  }
  git('update-ref', 'refs/remotes/origin/main', commits[2])
  env = {
    ...isolatedGitEnv,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    PAGES_ENV_FILE: join(root, 'missing.env'),
    RELEASE_FETCH: '0',
    RELEASE_POLL_INTERVAL: '0',
    RELEASE_WAIT_CI_SECONDS: '5',
    RELEASE_DISPATCH_WAIT_SECONDS: '2',
    RELEASE_REPO: repoSlug,
    RELEASE_API: api,
    RELEASE_WEB: web,
    RELEASE_ADMIN: admin,
  }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('release.sh', () => {
  it('skips when --include commit is already live on every side it touched', () => {
    // Web already serves c1 (which only touched apps/web); API still serves c0, yet c1 is live.
    serve({
      [`${api}/health`]: health(commits[0]),
      [`${web}/version.json`]: site(commits[1]),
      [`${admin}/version.json`]: site(commits[0]),
    })
    mockGh({})

    const res = runRelease('--include', commits[1])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('outcome=already_live')
    expect(ghCalls()).toEqual([])
  })

  it('skips when production already serves all deployable changes up to origin/main', () => {
    serve({
      [`${api}/health`]: health(commits[2]),
      [`${web}/version.json`]: site(commits[2]),
      [`${admin}/version.json`]: site(commits[2]),
    })
    mockGh({})

    const res = runRelease()
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('outcome=already_live')
    expect(ghCalls()).toEqual([])
  })

  it('piggybacks on an active deploy run that already covers --include without dispatching', () => {
    serve({
      [`${api}/health`]: health(commits[0]),
      [`${web}/version.json`]: site(commits[0]),
      [`${admin}/version.json`]: site(commits[0]),
    })
    mockGh({
      [`repos/${repoSlug}/actions/workflows/deploy.yml/runs?branch=main&per_page=20`]: [
        {
          workflow_runs: [
            {
              id: 9001,
              status: 'in_progress',
              head_sha: commits[2],
              html_url: `https://github.com/${repoSlug}/actions/runs/9001`,
            },
          ],
        },
      ],
    })

    const res = runRelease('--include', commits[1])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('outcome=piggybacked')
    expect(res.stdout).toContain('run_id=9001')
    expect(ghCalls().some((c) => c.startsWith('workflow run'))).toBe(false)
    expect(ghCalls()).toContain(`run watch 9001 --repo ${repoSlug} --exit-status`)
  })

  it('waits for Web checks, re-checks active deploys, and dispatches once when none exists', () => {
    serve({
      [`${api}/health`]: health(commits[0]),
      [`${web}/version.json`]: site(commits[0]),
      [`${admin}/version.json`]: site(commits[0]),
    })
    mockGh(
      {
        [`repos/${repoSlug}/actions/workflows/deploy.yml/runs?branch=main&per_page=20`]: [
          { workflow_runs: [] },
        ],
        [`repos/${repoSlug}/actions/workflows/web.yml/runs?head_sha=${commits[2]}&event=push&branch=main&per_page=100`]:
          [
            { workflow_runs: [{ status: 'in_progress', conclusion: null }] },
            { workflow_runs: [{ status: 'completed', conclusion: 'success' }] },
          ],
        [`repos/${repoSlug}/actions/workflows/deploy.yml/runs?event=workflow_dispatch&branch=main&per_page=5`]:
          [{ workflow_runs: [{ id: 100 }] }],
      },
      {
        dispatchedRun: {
          id: 101,
          html_url: `https://github.com/${repoSlug}/actions/runs/101`,
        },
      },
    )

    const res = runRelease('--reason', 'ship fix')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('outcome=dispatched')
    expect(res.stdout).toContain('run_id=101')
    expect(ghCalls()).toContain(
      `workflow run deploy.yml --repo ${repoSlug} --ref main -f mode=incremental -f reason=ship fix`,
    )
    expect(ghCalls()).toContain(`run watch 101 --repo ${repoSlug} --exit-status`)
  })

  it('piggybacks instead of dispatching when another Agent dispatches while waiting for CI', () => {
    serve({
      [`${api}/health`]: health(commits[0]),
      [`${web}/version.json`]: site(commits[0]),
      [`${admin}/version.json`]: site(commits[0]),
    })
    mockGh({
      [`repos/${repoSlug}/actions/workflows/deploy.yml/runs?branch=main&per_page=20`]: [
        { workflow_runs: [] },
        {
          workflow_runs: [
            {
              id: 9002,
              status: 'queued',
              head_sha: commits[2],
              html_url: `https://github.com/${repoSlug}/actions/runs/9002`,
            },
          ],
        },
      ],
      [`repos/${repoSlug}/actions/workflows/web.yml/runs?head_sha=${commits[2]}&event=push&branch=main&per_page=100`]:
        [{ workflow_runs: [{ status: 'completed', conclusion: 'success' }] }],
    })

    const res = runRelease('--no-watch')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('outcome=piggybacked')
    expect(res.stdout).toContain('run_id=9002')
    expect(ghCalls().some((c) => c.startsWith('workflow run'))).toBe(false)
    expect(ghCalls().some((c) => c.startsWith('run watch'))).toBe(false)
  })

  it('refuses to dispatch when main Web checks failed', () => {
    serve({
      [`${api}/health`]: health(commits[0]),
      [`${web}/version.json`]: site(commits[0]),
      [`${admin}/version.json`]: site(commits[0]),
    })
    mockGh({
      [`repos/${repoSlug}/actions/workflows/deploy.yml/runs?branch=main&per_page=20`]: [
        { workflow_runs: [] },
      ],
      [`repos/${repoSlug}/actions/workflows/web.yml/runs?head_sha=${commits[2]}&event=push&branch=main&per_page=100`]:
        [{ workflow_runs: [{ status: 'completed', conclusion: 'failure' }] }],
    })

    const res = runRelease()
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('failed; refusing to dispatch')
    expect(ghCalls().some((c) => c.startsWith('workflow run'))).toBe(false)
  })

  it('rejects --include commit that is not on origin/main', () => {
    git('checkout', '-q', '-b', 'unmerged', commits[0])
    writeFileSync(join(repo, 'apps/web/unmerged.ts'), 'x\n')
    git('add', 'apps/web/unmerged.ts')
    git('commit', '-q', '-m', 'unmerged')
    const unmerged = git('rev-parse', 'HEAD')
    git('checkout', '-q', '-')

    serve({})
    mockGh({})
    const res = runRelease('--include', unmerged)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('is not on origin/main')
  })
})
