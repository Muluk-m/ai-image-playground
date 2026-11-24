import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** macmini2 静默合批自动发布触发器 scripts/deploy-debounce-tick.sh 测试（假 curl + 真实 jq）。 */
const script = resolve(__dirname, '../../../../../scripts/deploy-debounce-tick.sh')
const repoSlug = 'Muluk-m/ai-image-playground'
const apiBase = 'https://api.github.test'
const prodApi = 'https://api.example.net'
const prodWeb = 'https://web.example.net'
const prodAdmin = 'https://admin.example.net'
const shaA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const shaB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const shaC = 'cccccccccccccccccccccccccccccccccccccccc'
const secretToken = 'github_pat_fake_secret_token_for_test'

let root: string
let tokenFile: string
let pauseFile: string
let stateFile: string
let dispatchLog: string
let argvLog: string
let env: NodeJS.ProcessEnv

function mockCurl(responses: Record<string, string>, options?: { dispatchStatus?: string }) {
  const respFile = join(root, 'curl-responses.json')
  writeFileSync(respFile, JSON.stringify(responses))
  const dispatchStatus = options?.dispatchStatus ?? '204'
  writeFileSync(
    join(root, 'bin/curl'),
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> '${argvLog}'
method=GET
write_code=false
body=
url=
while [ "$#" -gt 0 ]; do
  case $1 in
    -X) method=$2; shift 2 ;;
    -d) body=$2; shift 2 ;;
    -w) write_code=true; shift 2 ;;
    --config)
      if [ "$2" = - ]; then
        cfg=$(cat)
        printf '%s\\n' "$cfg" | grep -Fq 'Authorization: Bearer ${secretToken}' || {
          echo "missing bearer header on stdin" >&2
          exit 99
        }
      fi
      shift 2
      ;;
    -o | -H | --max-time) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
if [ "$method" = POST ]; then
  printf '%s\\t%s\\n' "$url" "$body" >> '${dispatchLog}'
  if [ "$write_code" = true ]; then
    printf '%s' '${dispatchStatus}'
  fi
  exit 0
fi
val=$(jq -r --arg u "$url" '.[$u] // "__MISSING__"' '${respFile}')
[ "$val" != "__MISSING__" ] || exit 22
printf '%s' "$val"
`,
  )
  chmodSync(join(root, 'bin/curl'), 0o755)
}

function baseResponses(opts?: {
  activeByStatus?: Partial<
    Record<'in_progress' | 'queued' | 'waiting' | 'pending' | 'requested', unknown[]>
  >
  dispatchedRuns?: unknown[]
  headSha?: string
  webCheckRuns?: unknown[]
  prodApiSha?: string
  prodWebSha?: string
  prodAdminSha?: string
  compareFiles?: string[]
  compareStatus?: string
}) {
  const headSha = opts?.headSha ?? shaB
  const apiSha = opts?.prodApiSha ?? shaA
  const webSha = opts?.prodWebSha ?? shaA
  const adminSha = opts?.prodAdminSha ?? shaA
  const compareFiles = opts?.compareFiles ?? ['apps/web/src/App.tsx']
  const comparePayload = JSON.stringify({
    status: opts?.compareStatus ?? 'ahead',
    total_commits: 1,
    files: compareFiles.map((filename) => ({ filename })),
  })
  const map: Record<string, string> = {
    [`${apiBase}/repos/${repoSlug}/commits/main`]: JSON.stringify({ sha: headSha }),
    [`${apiBase}/repos/${repoSlug}/actions/workflows/deploy.yml/runs?event=workflow_dispatch&branch=main&per_page=30`]:
      JSON.stringify({ workflow_runs: opts?.dispatchedRuns ?? [] }),
    [`${apiBase}/repos/${repoSlug}/actions/workflows/web.yml/runs?head_sha=${headSha}&event=push&branch=main&per_page=20`]:
      JSON.stringify({
        workflow_runs: opts?.webCheckRuns ?? [{ status: 'completed', conclusion: 'success' }],
      }),
    [`${prodApi}/health`]: JSON.stringify({ ok: true, version: `${apiSha}+${apiSha}` }),
    [`${prodWeb}/version.json`]: JSON.stringify({
      version: `${webSha.slice(0, 7)}-20261124T100000Z`,
    }),
    [`${prodAdmin}/version.json`]: JSON.stringify({
      version: `${adminSha.slice(0, 7)}-20261124T100000Z`,
    }),
    [`${apiBase}/repos/${repoSlug}/compare/${apiSha}...${headSha}`]: comparePayload,
    [`${apiBase}/repos/${repoSlug}/compare/${webSha.slice(0, 7)}...${headSha}`]: comparePayload,
    [`${apiBase}/repos/${repoSlug}/compare/${adminSha.slice(0, 7)}...${headSha}`]: comparePayload,
  }
  for (const st of ['in_progress', 'queued', 'waiting', 'pending', 'requested'] as const) {
    map[
      `${apiBase}/repos/${repoSlug}/actions/workflows/deploy.yml/runs?branch=main&status=${st}&per_page=5`
    ] = JSON.stringify({ workflow_runs: opts?.activeByStatus?.[st] ?? [] })
  }
  return map
}

function tick(nowIso: string, extraEnv?: Record<string, string>) {
  const nowEpoch = Math.floor(Date.parse(nowIso) / 1000)
  return spawnSync('sh', [script], {
    env: { ...env, DEPLOY_NOW_EPOCH: String(nowEpoch), ...extraEnv },
    encoding: 'utf8',
  })
}

function readDispatches() {
  if (!existsSync(dispatchLog)) return []
  return readFileSync(dispatchLog, 'utf8').trim().split('\n').filter(Boolean)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aip-debounce-tick-'))
  mkdirSync(join(root, 'bin'))
  tokenFile = join(root, 'deploy-dispatch.token')
  pauseFile = join(root, 'deploy-auto.pause')
  stateFile = join(root, 'state.json')
  dispatchLog = join(root, 'dispatches.log')
  argvLog = join(root, 'curl-argv.log')
  writeFileSync(tokenFile, `${secretToken}\n`, { mode: 0o600 })
  env = {
    ...process.env,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    PAGES_ENV_FILE: join(root, 'missing.env'),
    GITHUB_API_URL: apiBase,
    DEPLOY_REPO: repoSlug,
    DEPLOY_DISPATCH_TOKEN_FILE: tokenFile,
    DEPLOY_PAUSE_FILE: pauseFile,
    DEPLOY_STATE_FILE: stateFile,
    DEPLOY_API_URL: prodApi,
    DEPLOY_WEB_URL: prodWeb,
    DEPLOY_ADMIN_URL: prodAdmin,
    DEPLOY_DEBOUNCE_MINUTES: '10',
    DEPLOY_MAX_WAIT_MINUTES: '45',
    DEPLOY_MAX_RETRIES: '2',
    DEPLOY_RETRY_COOLDOWN_MINUTES: '15',
  }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('deploy-debounce-tick.sh', () => {
  it('exits silently when pause file exists', () => {
    writeFileSync(pauseFile, '')
    mockCurl({})
    const res = tick('2026-11-24T12:15:00Z')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('auto-release paused')
    expect(readDispatches()).toEqual([])
  })

  it('skips when an active deploy exists in any non-completed status (e.g. waiting)', () => {
    mockCurl(
      baseResponses({
        activeByStatus: { waiting: [{ id: 55, status: 'waiting' }] },
      }),
    )
    const res = tick('2026-11-24T12:20:00Z')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('deploy already active (55 waiting)')
    expect(res.stdout).not.toContain('warning:')
    expect(readDispatches()).toEqual([])
  })

  it('skips when only Web changed and Web already serves head_sha while API/Admin stayed on older commits', () => {
    mockCurl(
      baseResponses({
        prodWebSha: shaB,
        prodApiSha: shaA,
        prodAdminSha: shaA,
        compareFiles: ['apps/web/src/App.tsx'],
      }),
    )
    const res = tick('2026-11-24T12:20:00Z')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain(`production already up to date for ${shaB}`)
    expect(readDispatches()).toEqual([])
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    expect(state.shipped_sha).toBe(shaB)
  })

  it('holds from observed HEAD change time, dispatches compact payload with stdin token, and confirms success', () => {
    mockCurl(baseResponses({ headSha: shaB }))

    // First observation of shaB at 12:00: records observed_head_at=12:00 and holds.
    const first = tick('2026-11-24T12:00:00Z', { DEPLOY_DISPATCH_ID: 'auto-test-1' })
    expect(first.status).toBe(0)
    expect(first.stdout).toContain('holding')
    expect(readDispatches()).toEqual([])

    // 11 minutes after observing shaB: dispatches once with compact JSON and stdin token.
    const fire = tick('2026-11-24T12:11:00Z', { DEPLOY_DISPATCH_ID: 'auto-test-1' })
    expect(fire.status).toBe(0)
    expect(fire.stdout).toContain('dispatched auto-batch (quiet 10m)')
    expect(readDispatches()).toHaveLength(1)
    expect(readDispatches()[0]).toContain('"mode":"incremental"')
    expect(readDispatches()[0]).toContain('"dispatch_id":"auto-test-1"')
    expect(readFileSync(argvLog, 'utf8')).not.toContain(secretToken)

    // After the correlated run succeeds, next tick marks shipped_sha and stays idle.
    mockCurl(
      baseResponses({
        headSha: shaB,
        dispatchedRuns: [
          {
            id: 701,
            status: 'completed',
            conclusion: 'success',
            display_title: 'Deploy production (incremental) [auto-test-1]',
          },
        ],
      }),
    )
    const done = tick('2026-11-24T12:18:00Z')
    expect(done.status).toBe(0)
    expect(done.stdout).toContain('succeeded for')
    expect(readDispatches()).toHaveLength(1)
  })

  it('retries after cooldown if the dispatched run failed, and stops after max retries', () => {
    mockCurl(baseResponses({ headSha: shaB }))
    expect(tick('2026-11-24T12:00:00Z', { DEPLOY_DISPATCH_ID: 'auto-fail-1' }).status).toBe(0)
    expect(tick('2026-11-24T12:11:00Z', { DEPLOY_DISPATCH_ID: 'auto-fail-1' }).status).toBe(0)
    expect(readDispatches()).toHaveLength(1)

    // Run failed at 12:15 (only 4m after dispatch < 15m cooldown): should cool down.
    mockCurl(
      baseResponses({
        headSha: shaB,
        dispatchedRuns: [
          {
            id: 801,
            status: 'completed',
            conclusion: 'failure',
            display_title: 'Deploy production (incremental) [auto-fail-1]',
          },
        ],
      }),
    )
    const cool = tick('2026-11-24T12:15:00Z', { DEPLOY_DISPATCH_ID: 'auto-fail-2' })
    expect(cool.status).toBe(0)
    expect(cool.stdout).toContain('cooling down before retry')
    expect(readDispatches()).toHaveLength(1)

    // After 15m cooldown (12:27): retries once (attempt 2).
    const retry = tick('2026-11-24T12:27:00Z', { DEPLOY_DISPATCH_ID: 'auto-fail-2' })
    expect(retry.status).toBe(0)
    expect(retry.stdout).toContain('dispatched auto-batch')
    expect(readDispatches()).toHaveLength(2)

    // Second attempt also fails: stops at max_retries=2.
    mockCurl(
      baseResponses({
        headSha: shaB,
        dispatchedRuns: [
          {
            id: 802,
            status: 'completed',
            conclusion: 'failure',
            display_title: 'Deploy production (incremental) [auto-fail-2]',
          },
        ],
      }),
    )
    const capped = tick('2026-11-24T12:50:00Z', { DEPLOY_DISPATCH_ID: 'auto-fail-3' })
    expect(capped.status).toBe(0)
    expect(capped.stdout).toContain('max retries (2) reached')
    expect(readDispatches()).toHaveLength(2)
  })

  it('starts max-wait timer even while Web checks are running and flushes once green after 45m', () => {
    // At 12:00 shaB is unshipped while Web checks are still running -> records first_unshipped_at=12:00.
    mockCurl(
      baseResponses({
        headSha: shaB,
        webCheckRuns: [{ status: 'in_progress', conclusion: null }],
      }),
    )
    const running = tick('2026-11-24T12:00:00Z')
    expect(running.status).toBe(0)
    expect(running.stdout).toContain("is 'running'; not dispatching")

    // At 12:46 shaC just merged (quiet=0m < 10m), Web checks pass, total batch wait=46m >= 45m -> flushes!
    mockCurl(baseResponses({ headSha: shaC }))
    const flush = tick('2026-11-24T12:46:00Z', { DEPLOY_DISPATCH_ID: 'auto-flush-1' })
    expect(flush.status).toBe(0)
    expect(flush.stdout).toContain('dispatched auto-batch (max wait 45m)')
    expect(readDispatches()).toHaveLength(1)
  })
})
