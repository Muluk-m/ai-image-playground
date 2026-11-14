import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const script = new URL('../ci-reuse-web-checks.sh', import.meta.url).pathname
const sha = 'c'.repeat(40)

const required = [
  'lint',
  'typecheck',
  'build',
  'bff (bff 1/3)',
  'bff (bff 2/3)',
  'bff (bff 3/3)',
  'bff (packages)',
  'web-test (1/3)',
  'web-test (2/3)',
  'web-test (3/3)',
  'with-overlay',
  'with-overlay (build)',
  'with-overlay (typecheck)',
]
const jobs = (overrides = {}, drop = []) =>
  required
    .filter((name) => !drop.includes(name))
    .map((name) => ({ name, conclusion: name in overrides ? overrides[name] : 'success' }))
const run = (over = {}) => ({
  id: 7,
  head_sha: sha,
  event: 'push',
  head_branch: 'test',
  status: 'completed',
  created_at: '2026-11-14T00:00:00Z',
  ...over,
})

// A fake `gh api <url>` answering from fixtures; `jobs` may be a list of responses, one per poll.
function reuse({ runs, jobList }) {
  const dir = mkdtempSync(join(tmpdir(), 'reuse-'))
  try {
    const gh = join(dir, 'gh')
    writeFileSync(join(dir, 'runs.json'), JSON.stringify({ workflow_runs: runs }))
    writeFileSync(join(dir, 'jobs.json'), JSON.stringify({ jobs: jobList }))
    writeFileSync(
      gh,
      `#!/bin/sh\ncase "$2" in\n  *workflows/web.yml/runs*) cat "${dir}/runs.json" ;;\n  *runs/*/jobs*) cat "${dir}/jobs.json" ;;\n  *) exit 1 ;;\nesac\n`,
    )
    chmodSync(gh, 0o755)
    const out = join(dir, 'out')
    writeFileSync(out, '')
    const result = spawnSync('bash', [script], {
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        REPO: 'o/r',
        SHA: sha,
        GITHUB_OUTPUT: out,
        WEB_RUN_GRACE: '0',
        WEB_WAIT_LIMIT: '0',
        WEB_POLL: '0',
      },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    return readFileSync(out, 'utf8').trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('reuses a completed run of this commit where every required job succeeded', () => {
  assert.equal(reuse({ runs: [run()], jobList: jobs() }), 'reused=true')
  // Extra jobs (cli, docker-web) do not matter, and a skipped optional one is fine.
  const extra = [...jobs(), { name: 'cli', conclusion: 'skipped' }, { name: 'docker-web', conclusion: 'failure' }]
  assert.equal(reuse({ runs: [run()], jobList: extra }), 'reused=true')
})

test('falls back when there is no run for this commit', () => {
  assert.equal(reuse({ runs: [], jobList: jobs() }), 'reused=false')
})

test('ignores runs of another commit, event or branch', () => {
  for (const over of [{ head_sha: 'd'.repeat(40) }, { event: 'pull_request' }, { head_branch: 'main' }]) {
    assert.equal(reuse({ runs: [run(over)], jobList: jobs() }), 'reused=false')
  }
})

test('falls back when a required job failed, was cancelled or was skipped', () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped']) {
    assert.equal(reuse({ runs: [run()], jobList: jobs({ 'with-overlay': conclusion }) }), 'reused=false')
  }
})

test('falls back when a required job is missing from the run (renamed or removed in web.yml)', () => {
  assert.equal(reuse({ runs: [run()], jobList: jobs({}, ['with-overlay (build)']) }), 'reused=false')
  assert.equal(reuse({ runs: [run()], jobList: [] }), 'reused=false')
})

test('does not reuse a run that is still going once the wait runs out', () => {
  const pending = jobs({ build: null })
  assert.equal(reuse({ runs: [run({ status: 'in_progress' })], jobList: pending }), 'reused=false')
  // Every required job green but the run not completed yet is not proof either.
  assert.equal(reuse({ runs: [run({ status: 'in_progress' })], jobList: jobs() }), 'reused=false')
})

test('picks the newest run of the commit', () => {
  const older = run({ id: 1, created_at: '2026-11-14T00:00:00Z' })
  const newer = run({ id: 2, created_at: '2026-11-14T01:00:00Z' })
  assert.equal(reuse({ runs: [older, newer], jobList: jobs() }), 'reused=true')
})
