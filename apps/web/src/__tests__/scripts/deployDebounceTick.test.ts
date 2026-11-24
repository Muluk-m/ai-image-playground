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
      # Consume stdin config to verify token comes via stdin rather than argv.
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
  deployRuns?: unknown[]
  headSha?: string
  commitDate?: string
  tags?: unknown[]
  webCheckRuns?: unknown[]
  prodApiSha?: string
  prodWebSha?: string
  prodAdminSha?: string
}) {
  const headSha = opts?.headSha ?? shaB
  const commitDate = opts?.commitDate ?? '2026-11-24T12:00:00Z'
  const apiSha = opts?.prodApiSha ?? shaA
  const webSha = opts?.prodWebSha ?? shaA
  const adminSha = opts?.prodAdminSha ?? shaA
  return {
    [`${apiBase}/repos/${repoSlug}/actions/workflows/deploy.yml/runs?branch=main&per_page=10`]:
      JSON.stringify({ workflow_runs: opts?.deployRuns ?? [] }),
    [`${apiBase}/repos/${repoSlug}/commits/main`]: JSON.stringify({
      sha: headSha,
      commit: { committer: { date: commitDate } },
    }),
    [`${apiBase}/repos/${repoSlug}/tags?per_page=10`]: JSON.stringify(opts?.tags ?? []),
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
  }
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

  it('skips when a deploy run is already active (in_progress, queued, waiting, etc.)', () => {
    mockCurl(
      baseResponses({
        deployRuns: [{ id: 55, status: 'waiting', head_sha: shaA, conclusion: null }],
      }),
    )
    const res = tick('2026-11-24T12:20:00Z')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('deploy already active (55 waiting)')
    expect(res.stdout).not.toContain('warning:')
    expect(readDispatches()).toEqual([])
  })

  it('skips when head_sha already has a release tag from an auto-advanced successful deploy even after a cancelled run', () => {
    mockCurl(
      baseResponses({
        deployRuns: [
          { id: 56, status: 'completed', head_sha: shaA, conclusion: 'cancelled' },
          { id: 54, status: 'completed', head_sha: shaA, conclusion: 'success' },
        ],
        tags: [{ name: 'v0.1.9', commit: { sha: shaB } }],
        // Only web was updated to shaB; api/admin stayed on shaA.
        prodWebSha: shaB,
      }),
    )
    const res = tick('2026-11-24T12:20:00Z')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain(`release tag already exists for ${shaB}`)
    expect(readDispatches()).toEqual([])
    const state = JSON.parse(readFileSync(stateFile, 'utf8'))
    expect(state.last_dispatched_sha).toBe(shaB)
  })

  it('skips when Web checks for main HEAD have not passed yet', () => {
    mockCurl(
      baseResponses({
        webCheckRuns: [{ status: 'in_progress', conclusion: null }],
      }),
    )
    const res = tick('2026-11-24T12:20:00Z')
    expect(res.status).toBe(0)
    expect(res.stdout).toContain("is 'running'; not dispatching")
    expect(readDispatches()).toEqual([])
  })

  it('holds during the quiet period, then dispatches once quiet >= debounce and skips next tick', () => {
    mockCurl(baseResponses({ commitDate: '2026-11-24T12:00:00Z' }))

    // 4 minutes after merge: hold and record first_unshipped_at.
    const hold = tick('2026-11-24T12:04:00Z')
    expect(hold.status).toBe(0)
    expect(hold.stdout).toContain('holding')
    expect(readDispatches()).toEqual([])

    // 11 minutes after merge: dispatch once, passing token via stdin only.
    const fire = tick('2026-11-24T12:11:00Z')
    expect(fire.status).toBe(0)
    expect(fire.stdout).toContain('dispatched auto-batch (quiet 10m)')
    expect(readDispatches()).toHaveLength(1)
    expect(readDispatches()[0]).toContain('"mode":"incremental"')
    expect(readFileSync(argvLog, 'utf8')).not.toContain(secretToken)

    // Subsequent tick for the same HEAD skips via last_dispatched_sha.
    const again = tick('2026-11-24T12:15:00Z')
    expect(again.status).toBe(0)
    expect(again.stdout).toContain(`already dispatched ${shaB}`)
    expect(readDispatches()).toHaveLength(1)
  })

  it('flushes the batch when max wait ceiling is reached despite recent merges', () => {
    mockCurl(baseResponses({ commitDate: '2026-11-24T12:00:00Z' }))
    // First unshipped commit observed at 12:02 (within quiet window).
    expect(tick('2026-11-24T12:02:00Z').status).toBe(0)
    expect(readDispatches()).toEqual([])

    // Another commit merged at 12:46, tick runs at 12:48 (quiet=2m < 10m, but waited=46m >= 45m).
    mockCurl(baseResponses({ commitDate: '2026-11-24T12:46:00Z' }))
    const flush = tick('2026-11-24T12:48:00Z')
    expect(flush.status).toBe(0)
    expect(flush.stdout).toContain('dispatched auto-batch (max wait 45m)')
    expect(readDispatches()).toHaveLength(1)
  })
})
