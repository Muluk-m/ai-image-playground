import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** 幂等生产发布入口 scripts/release.sh 测试：已在线跳过、搭便车复用、并发锁序列化、dispatch_id 精确关联。 */
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
 * - `gh workflow run ...`: records dispatch and appends a correlated run (with `[<dispatch_id>]` in
 *   display_title) into both active runs and workflow_dispatch runs, optionally alongside extra runs.
 * - `gh run watch ...`: logs args and exits 0.
 */
function mockGh(
  apiResponses: GhApiSequence,
  options?: {
    materializeRun?: boolean
    dispatchDelaySec?: number
    extraConcurrentRuns?: Array<{
      id: number
      status: string
      head_sha: string
      html_url: string
      display_title: string
    }>
    headShaForDispatched?: string
  },
) {
  const stateFile = join(root, 'gh-api-state.json')
  writeFileSync(stateFile, JSON.stringify({ responses: apiResponses, counts: {}, nextId: 101 }))
  const materialize = options?.materializeRun ?? true
  const dispatchDelay = options?.dispatchDelaySec ?? 0
  const extraRunsJson = JSON.stringify(options?.extraConcurrentRuns ?? [])
  const dispatchedHeadSha = options?.headShaForDispatched ?? commits[2]
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
    did=
    while [ "$#" -gt 0 ]; do
      case $1 in
        -f)
          case $2 in
            dispatch_id=*) did=\${2#dispatch_id=} ;;
          esac
          shift 2
          ;;
        *) shift ;;
      esac
    done
    if [ '${dispatchDelay}' -gt 0 ]; then
      sleep '${dispatchDelay}'
    fi
    if [ '${materialize ? '1' : '0'}' = 1 ]; then
      tmp=$(mktemp '${root}/gh-state.XXXXXX')
      jq --arg activeKey 'repos/${repoSlug}/actions/workflows/deploy.yml/runs?branch=main&per_page=100' \
         --arg dispKey 'repos/${repoSlug}/actions/workflows/deploy.yml/runs?event=workflow_dispatch&branch=main&per_page=20' \
         --arg did "$did" \
         --arg sha '${dispatchedHeadSha}' \
         --argjson extra '${extraRunsJson}' \
         '
         .nextId as $id |
         {
           id: $id,
           status: "queued",
           head_sha: $sha,
           html_url: ("https://github.com/${repoSlug}/actions/runs/" + ($id | tostring)),
           display_title: ("Deploy production (incremental) [" + $did + "]")
         } as $run |
         .nextId = ($id + 1) |
         .responses[$activeKey] = [{workflow_runs: ($extra + [$run])}] |
         .responses[$dispKey] = [{workflow_runs: ($extra + [$run])}]
         ' '${stateFile}' >"$tmp"
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

function runReleaseAsync(...args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolvePromise) => {
      const child = spawn('sh', [script, ...args], { cwd: repo, env })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => {
        stdout += String(d)
      })
      child.stderr.on('data', (d) => {
        stderr += String(d)
      })
      child.on('close', (status) => resolvePromise({ status, stdout, stderr }))
    },
  )
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
    RELEASE_DISPATCH_POLL_SECONDS: '0',
    RELEASE_LOCK_DIR: join(root, 'release.lock'),
    RELEASE_REPO: repoSlug,
    RELEASE_API: api,
    RELEASE_WEB: web,
    RELEASE_ADMIN: admin,
  }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('release.sh', () => {
  it('skips when --include commit is already live on every side it touched', () => {
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
      [`repos/${repoSlug}/actions/workflows/deploy.yml/runs?branch=main&per_page=100`]: [
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

  it('correlates its own run by dispatch_id even when another concurrent run has a higher ID', () => {
    serve({
      [`${api}/health`]: health(commits[0]),
      [`${web}/version.json`]: site(commits[0]),
      [`${admin}/version.json`]: site(commits[0]),
    })
    mockGh(
      {
        [`repos/${repoSlug}/actions/workflows/deploy.yml/runs?branch=main&per_page=100`]: [
          { workflow_runs: [] },
        ],
        [`repos/${repoSlug}/actions/workflows/web.yml/runs?head_sha=${commits[2]}&event=push&branch=main&per_page=100`]:
          [
            { workflow_runs: [{ status: 'in_progress', conclusion: null }] },
            { workflow_runs: [{ status: 'completed', conclusion: 'success' }] },
          ],
      },
      {
        extraConcurrentRuns: [
          {
            id: 102,
            status: 'queued',
            head_sha: commits[2],
            html_url: `https://github.com/${repoSlug}/actions/runs/102`,
            display_title: 'Deploy production (incremental) [other-caller-999]',
          },
        ],
      },
    )

    const res = runRelease('--reason', 'ship fix')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('outcome=dispatched')
    expect(res.stdout).toContain('run_id=101')
    expect(ghCalls()).toContain(`run watch 101 --repo ${repoSlug} --exit-status`)
    expect(ghCalls()).not.toContain(`run watch 102 --repo ${repoSlug} --exit-status`)
  })

  it('serializes two concurrent invocations so only one dispatches and the second piggybacks', async () => {
    serve({
      [`${api}/health`]: health(commits[0]),
      [`${web}/version.json`]: site(commits[0]),
      [`${admin}/version.json`]: site(commits[0]),
    })
    mockGh(
      {
        [`repos/${repoSlug}/actions/workflows/deploy.yml/runs?branch=main&per_page=100`]: [
          { workflow_runs: [] },
        ],
        [`repos/${repoSlug}/actions/workflows/web.yml/runs?head_sha=${commits[2]}&event=push&branch=main&per_page=100`]:
          [{ workflow_runs: [{ status: 'completed', conclusion: 'success' }] }],
      },
      { dispatchDelaySec: 1 },
    )

    const [a, b] = await Promise.all([runReleaseAsync('--no-watch'), runReleaseAsync('--no-watch')])
    expect(a.status).toBe(0)
    expect(b.status).toBe(0)
    const outcomes = [a.stdout, b.stdout].map((s) =>
      s.includes('outcome=dispatched')
        ? 'dispatched'
        : s.includes('outcome=piggybacked')
          ? 'piggybacked'
          : 'other',
    )
    expect(outcomes.sort()).toEqual(['dispatched', 'piggybacked'])
    expect(ghCalls().filter((c) => c.startsWith('workflow run'))).toHaveLength(1)
  })

  it('safely reaps a stale lock across two concurrent callers without double-dispatching', async () => {
    const lockDir = join(root, 'release.lock')
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'pid'), '999999\n')

    serve({
      [`${api}/health`]: health(commits[0]),
      [`${web}/version.json`]: site(commits[0]),
      [`${admin}/version.json`]: site(commits[0]),
    })
    mockGh(
      {
        [`repos/${repoSlug}/actions/workflows/deploy.yml/runs?branch=main&per_page=100`]: [
          { workflow_runs: [] },
        ],
        [`repos/${repoSlug}/actions/workflows/web.yml/runs?head_sha=${commits[2]}&event=push&branch=main&per_page=100`]:
          [{ workflow_runs: [{ status: 'completed', conclusion: 'success' }] }],
      },
      { dispatchDelaySec: 1 },
    )

    const [a, b] = await Promise.all([runReleaseAsync('--no-watch'), runReleaseAsync('--no-watch')])
    expect(a.status).toBe(0)
    expect(b.status).toBe(0)
    const outcomes = [a.stdout, b.stdout].map((s) =>
      s.includes('outcome=dispatched')
        ? 'dispatched'
        : s.includes('outcome=piggybacked')
          ? 'piggybacked'
          : 'other',
    )
    expect(outcomes.sort()).toEqual(['dispatched', 'piggybacked'])
    expect(ghCalls().filter((c) => c.startsWith('workflow run'))).toHaveLength(1)
  })

  it('fails closed when active deploy runs cannot be queried instead of blindly dispatching', () => {
    serve({
      [`${api}/health`]: health(commits[0]),
      [`${web}/version.json`]: site(commits[0]),
      [`${admin}/version.json`]: site(commits[0]),
    })
    writeFileSync(
      join(root, 'bin/gh'),
      `#!/bin/sh
printf '%s\\n' "$*" >> '${ghLogFile}'
exit 1
`,
    )
    chmodSync(join(root, 'bin/gh'), 0o755)

    const res = runRelease('--no-watch')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('refusing to dispatch without verifying idempotency')
    expect(ghCalls().some((c) => c.startsWith('workflow run'))).toBe(false)
  })

  it('exits non-zero when watch is enabled and the dispatched run cannot be located', () => {
    serve({
      [`${api}/health`]: health(commits[0]),
      [`${web}/version.json`]: site(commits[0]),
      [`${admin}/version.json`]: site(commits[0]),
    })
    mockGh(
      {
        [`repos/${repoSlug}/actions/workflows/deploy.yml/runs?branch=main&per_page=100`]: [
          { workflow_runs: [] },
        ],
        [`repos/${repoSlug}/actions/workflows/web.yml/runs?head_sha=${commits[2]}&event=push&branch=main&per_page=100`]:
          [{ workflow_runs: [{ status: 'completed', conclusion: 'success' }] }],
      },
      { materializeRun: false },
    )

    const res = runRelease()
    expect(res.status).toBe(1)
    expect(res.stdout).toContain('outcome=dispatched')
    expect(res.stderr).toContain('do not blindly re-dispatch')
  })

  it('refuses to dispatch when main Web checks failed', () => {
    serve({
      [`${api}/health`]: health(commits[0]),
      [`${web}/version.json`]: site(commits[0]),
      [`${admin}/version.json`]: site(commits[0]),
    })
    mockGh({
      [`repos/${repoSlug}/actions/workflows/deploy.yml/runs?branch=main&per_page=100`]: [
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
