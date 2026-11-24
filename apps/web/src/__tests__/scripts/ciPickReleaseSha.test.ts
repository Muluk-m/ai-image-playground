import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/** deploy.yml 拿到发布锁后自动选最新绿色 main 提交的逻辑测试（真实 git 历史 + 假 gh + 真实 jq）。 */
const script = resolve(__dirname, '../../../../../scripts/ci-pick-release-sha.sh')
const repoSlug = 'Muluk-m/ai-image-playground'
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

type WorkflowRun = {
  head_sha: string
  status: string
  conclusion: string | null
}

function mockGh(runsByEndpoint: Record<string, WorkflowRun[]>) {
  const responsesFile = join(root, 'gh-responses.json')
  const wrapped: Record<string, { workflow_runs: WorkflowRun[] }> = {}
  for (const [k, v] of Object.entries(runsByEndpoint)) {
    wrapped[k] = { workflow_runs: v }
  }
  writeFileSync(responsesFile, JSON.stringify(wrapped))
  writeFileSync(
    join(root, 'bin/gh'),
    `#!/bin/sh
set -eu
cmd=$1
shift
[ "$cmd" = api ] || { echo "unexpected gh cmd: $cmd" >&2; exit 2; }
endpoint=$1
shift
jq_expr=.
while [ "$#" -gt 0 ]; do
  case $1 in
    --jq) jq_expr=$2; shift 2 ;;
    *) shift ;;
  esac
done
payload=$(jq -c --arg key "$endpoint" '.[$key] // {workflow_runs: []}' '${responsesFile}')
printf '%s' "$payload" | jq -r "$jq_expr"
`,
  )
  chmodSync(join(root, 'bin/gh'), 0o755)
}

function runPick(eventSha: string, pinSha: 'true' | 'false', extraEnv?: Record<string, string>) {
  const outFile = join(root, `out-${Math.random().toString(36).slice(2)}`)
  writeFileSync(outFile, '')
  const run = spawnSync('sh', [script, eventSha, pinSha, repoSlug], {
    cwd: repo,
    env: { ...env, GITHUB_OUTPUT: outFile, ...extraEnv },
    encoding: 'utf8',
  })
  const outputs = Object.fromEntries(
    readFileSync(outFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('=', 2)),
  )
  return { ...run, outputs }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aip-pick-sha-'))
  repo = join(root, 'repo')
  mkdirSync(repo)
  mkdirSync(join(root, 'bin'))
  git('init', '-q')
  commits = []
  for (const n of [1, 2, 3]) {
    writeFileSync(join(repo, `file-${n}.txt`), `${n}\n`)
    git('add', `file-${n}.txt`)
    git('commit', '-q', '-m', `c${n}`)
    commits.push(git('rev-parse', 'HEAD'))
  }
  env = {
    ...isolatedGitEnv,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
  }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('ci-pick-release-sha.sh', () => {
  it('advances from event_sha to the newest green main commit when pin_sha=false', () => {
    mockGh({
      [`repos/${repoSlug}/actions/workflows/web.yml/runs?event=push&branch=main&status=success&per_page=100`]:
        [
          { head_sha: commits[2], status: 'completed', conclusion: 'success' },
          { head_sha: commits[0], status: 'completed', conclusion: 'success' },
        ],
    })
    const res = runPick(commits[0], 'false')
    expect(res.status).toBe(0)
    expect(res.outputs).toEqual({ sha: commits[2], advanced: 'true' })
  })

  it('picks the newest green commit below a still-running or failed HEAD', () => {
    mockGh({
      [`repos/${repoSlug}/actions/workflows/web.yml/runs?event=push&branch=main&status=success&per_page=100`]:
        [
          { head_sha: commits[1], status: 'completed', conclusion: 'success' },
          { head_sha: commits[0], status: 'completed', conclusion: 'success' },
        ],
    })
    const res = runPick(commits[0], 'false')
    expect(res.status).toBe(0)
    expect(res.outputs).toEqual({ sha: commits[1], advanced: 'true' })
  })

  it('falls back to exact per-commit checks when the green runs page is truncated', () => {
    // Simulate a saturated first page containing only an unrelated old rerun, while commits[1]
    // actually succeeded on main and commits[2] is still running.
    mockGh({
      [`repos/${repoSlug}/actions/workflows/web.yml/runs?event=push&branch=main&status=success&per_page=1`]:
        [
          {
            head_sha: '0000000000000000000000000000000000000000',
            status: 'completed',
            conclusion: 'success',
          },
        ],
      [`repos/${repoSlug}/actions/workflows/web.yml/runs?head_sha=${commits[2]}&event=push&branch=main&per_page=100`]:
        [{ head_sha: commits[2], status: 'in_progress', conclusion: null }],
      [`repos/${repoSlug}/actions/workflows/web.yml/runs?head_sha=${commits[1]}&event=push&branch=main&per_page=100`]:
        [{ head_sha: commits[1], status: 'completed', conclusion: 'success' }],
    })
    const res = runPick(commits[0], 'false', { PICK_GREEN_PAGE_SIZE: '1' })
    expect(res.status).toBe(0)
    expect(res.outputs).toEqual({ sha: commits[1], advanced: 'true' })
  })

  it('falls back to green event_sha when newer commits have not passed yet', () => {
    mockGh({
      [`repos/${repoSlug}/actions/workflows/web.yml/runs?event=push&branch=main&status=success&per_page=100`]:
        [{ head_sha: commits[0], status: 'completed', conclusion: 'success' }],
    })
    const res = runPick(commits[0], 'false')
    expect(res.status).toBe(0)
    expect(res.outputs).toEqual({ sha: commits[0], advanced: 'false' })
  })

  it('stays on event_sha when pin_sha=true even if newer green commits exist', () => {
    mockGh({
      [`repos/${repoSlug}/actions/workflows/web.yml/runs?head_sha=${commits[0]}&event=push&branch=main&per_page=100`]:
        [{ head_sha: commits[0], status: 'completed', conclusion: 'success' }],
      [`repos/${repoSlug}/actions/workflows/web.yml/runs?event=push&branch=main&status=success&per_page=100`]:
        [{ head_sha: commits[2], status: 'completed', conclusion: 'success' }],
    })
    const res = runPick(commits[0], 'true')
    expect(res.status).toBe(0)
    expect(res.outputs).toEqual({ sha: commits[0], advanced: 'false' })
  })

  it('fails cleanly when neither event_sha nor newer commits passed Web checks', () => {
    mockGh({
      [`repos/${repoSlug}/actions/workflows/web.yml/runs?event=push&branch=main&status=success&per_page=100`]:
        [],
      [`repos/${repoSlug}/actions/workflows/web.yml/runs?head_sha=${commits[0]}&event=push&branch=main&per_page=100`]:
        [{ head_sha: commits[0], status: 'completed', conclusion: 'failure' }],
    })
    const res = runPick(commits[0], 'false')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain("is 'failure'")
  })

  it('rejects event_sha that is not an ancestor of HEAD', () => {
    git('checkout', '-q', '-b', 'side', commits[0])
    writeFileSync(join(repo, 'side.txt'), 'side\n')
    git('add', 'side.txt')
    git('commit', '-q', '-m', 'side')
    const sideSha = git('rev-parse', 'HEAD')
    git('checkout', '-q', '-')

    mockGh({})
    const res = runPick(sideSha, 'false')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('is not an ancestor of HEAD')
  })
})
