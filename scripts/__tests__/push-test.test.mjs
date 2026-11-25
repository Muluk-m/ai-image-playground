import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const script = new URL('../push-test.sh', import.meta.url).pathname
const reuseScript = new URL('../ci-reuse-web-checks.sh', import.meta.url).pathname
const required = (() => {
  const body = /^REQUIRED=\(\n([\s\S]*?)^\)$/m.exec(readFileSync(reuseScript, 'utf8'))?.[1] ?? ''
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1])
})()

const gitEnv = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

// origin (bare) with main, test (behind main) and work branch `feat`; `clone` is where the script runs.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'push-test-'))
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...gitEnv }, encoding: 'utf8' }).trim()
  const origin = join(dir, 'origin.git')
  const clone = join(dir, 'clone')
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
  git(dir, 'clone', '-q', origin, clone)
  const commit = (file, text) => {
    writeFileSync(join(clone, file), text)
    git(clone, 'add', file)
    git(clone, 'commit', '-q', '-m', file)
  }
  commit('a.txt', 'a\n')
  git(clone, 'push', '-q', 'origin', 'HEAD:main', 'HEAD:test')
  commit('main.txt', 'main\n')
  git(clone, 'push', '-q', 'origin', 'HEAD:main')
  git(clone, 'switch', '-q', '-c', 'feat')
  commit('feat.txt', 'feat\n')
  git(clone, 'push', '-q', 'origin', 'HEAD:feat')
  git(clone, 'switch', '-q', 'main')
  return { dir, origin, clone, git, commit, feat: git(clone, 'rev-parse', 'feat') }
}

const runOf = (sha, over = {}) => ({ id: 7, head_sha: sha, status: 'completed', created_at: '2026-11-25T00:00:00Z', ...over })
const jobs = (over = {}) => required.map((name) => ({ name, conclusion: name in over ? over[name] : 'success' }))

// Fake `gh api`: answers from runs.json / jobs.json; a dispatch logs and swaps in the *-after fixtures.
function run(env, { runs, jobList, after, args = ['feat'], perRun = {} }) {
  const bin = join(env.dir, 'bin')
  execFileSync('mkdir', ['-p', bin])
  writeFileSync(join(env.dir, 'runs.json'), JSON.stringify({ workflow_runs: runs }))
  writeFileSync(join(env.dir, 'jobs.json'), JSON.stringify({ jobs: jobList }))
  for (const [id, list] of Object.entries(perRun)) {
    writeFileSync(join(env.dir, `jobs-${id}.json`), JSON.stringify({ jobs: list }))
  }
  if (after) {
    writeFileSync(join(env.dir, 'runs-after.json'), JSON.stringify({ workflow_runs: after.runs }))
    writeFileSync(join(env.dir, 'jobs-after.json'), JSON.stringify({ jobs: after.jobList }))
  }
  const d = env.dir
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
case "$*" in
  *"-X POST"*dispatches*) echo "$*" >> "${d}/dispatched"; cp "${d}/runs-after.json" "${d}/runs.json"; cp "${d}/jobs-after.json" "${d}/jobs.json" ;;
  *workflows/web.yml/runs*) cat "${d}/runs.json" ;;
  *runs/*/jobs*) id=\${2#*runs/}; id=\${id%%/*}; if [ -f "${d}/jobs-$id.json" ]; then cat "${d}/jobs-$id.json"; else cat "${d}/jobs.json"; fi ;;
  *) exit 1 ;;
esac
`,
  )
  chmodSync(join(bin, 'gh'), 0o755)
  return spawnSync('bash', [script, ...args], {
    cwd: env.clone,
    env: { ...process.env, ...gitEnv, PATH: `${bin}:${process.env.PATH}`, PUSH_TEST_REPO: 'o/r', PUSH_TEST_POLL: '0' },
    encoding: 'utf8',
  })
}

const originTest = (env) => env.git(env.dir, '--git-dir', env.origin, 'rev-parse', 'test')
const contains = (env, rev) =>
  spawnSync('git', ['--git-dir', env.origin, 'merge-base', '--is-ancestor', rev, 'test']).status === 0

function withEnv(fn) {
  const env = setup()
  try {
    fn(env)
  } finally {
    rmSync(env.dir, { recursive: true, force: true })
  }
}

test('pushes test containing main and a branch that passed Web checks', () =>
  withEnv((env) => {
    const r = run(env, { runs: [runOf(env.feat)], jobList: jobs() })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(contains(env, 'main') && contains(env, 'feat'))
    assert.ok(!existsSync(join(env.dir, 'dispatched')))
  }))

test('refuses a branch whose Web checks failed and leaves test alone', () =>
  withEnv((env) => {
    const before = originTest(env)
    const r = run(env, { runs: [runOf(env.feat)], jobList: jobs({ typecheck: 'failure' }) })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /failed Web checks.*typecheck/)
    assert.equal(originTest(env), before)
  }))

test('waits on an in-progress run and gives up at the deadline', () =>
  withEnv((env) => {
    const r = run(env, {
      runs: [runOf(env.feat, { status: 'in_progress' })],
      jobList: jobs({ lint: null }),
      args: ['--wait-ci', '0', 'feat'],
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /not done after 0s/)
  }))

test('dispatches Web checks for a branch with no run, then pushes once it passes', () =>
  withEnv((env) => {
    const r = run(env, { runs: [], jobList: [], after: { runs: [runOf(env.feat)], jobList: jobs() } })
    assert.equal(r.status, 0, r.stderr)
    assert.match(readFileSync(join(env.dir, 'dispatched'), 'utf8'), /ref=feat/)
    assert.ok(contains(env, 'feat'))
  }))

test('refuses when the local branch differs from the pushed one', () =>
  withEnv((env) => {
    env.git(env.clone, 'switch', '-q', 'feat')
    env.commit('unpushed.txt', 'x\n')
    const r = run(env, { runs: [runOf(env.feat)], jobList: jobs() })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /differs from origin\/feat/)
  }))

test('stops on a merge conflict with test unchanged', () =>
  withEnv((env) => {
    env.commit('a.txt', 'main side\n')
    env.git(env.clone, 'push', '-q', 'origin', 'HEAD:main')
    env.git(env.clone, 'switch', '-q', 'feat')
    env.commit('a.txt', 'feat side\n')
    env.git(env.clone, 'push', '-q', 'origin', 'HEAD:feat')
    const sha = env.git(env.clone, 'rev-parse', 'HEAD')
    const before = originTest(env)
    const r = run(env, { runs: [runOf(sha)], jobList: jobs() })
    assert.equal(r.status, 3, r.stderr)
    assert.match(r.stderr, /merging feat into test conflicts[\s\S]*a\.txt/)
    assert.equal(originTest(env), before)
  }))

test('an older passing run counts even when a newer rerun failed', () =>
  withEnv((env) => {
    const runs = [runOf(env.feat, { id: 8, created_at: '2026-11-25T01:00:00Z' }), runOf(env.feat)]
    const perRun = { 8: jobs({ 'web-test (2/3)': 'failure' }), 7: jobs() }
    const r = run(env, { runs, jobList: [], perRun })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(contains(env, 'feat'))
  }))

test('a newest failed run with no passing run is reported by its id', () =>
  withEnv((env) => {
    const runs = [runOf(env.feat, { id: 8, created_at: '2026-11-25T01:00:00Z' }), runOf(env.feat, { status: 'in_progress' })]
    const perRun = { 8: jobs({ build: 'failure' }), 7: jobs({ lint: null }) }
    const r = run(env, { runs, jobList: [], perRun })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /run 8: build/)
  }))

test('merges again after a rejected push instead of giving up', () =>
  withEnv((env) => {
    // First push to origin is refused (as if someone else had just pushed test), the second lands.
    const hook = join(env.origin, 'hooks', 'pre-receive')
    writeFileSync(hook, `#!/bin/sh\n[ -f "${env.dir}/rejected" ] && exit 0\ntouch "${env.dir}/rejected"\nexit 1\n`)
    chmodSync(hook, 0o755)
    const r = run(env, { runs: [runOf(env.feat)], jobList: jobs() })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /push rejected.*attempt 1/)
    assert.ok(contains(env, 'main') && contains(env, 'feat'))
  }))

test('rejects main, test and remote-prefixed names', () =>
  withEnv((env) => {
    for (const name of ['main', 'test', 'origin/feat']) {
      assert.equal(run(env, { runs: [], jobList: [], args: [name] }).status, 2)
    }
  }))
