import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const script = new URL('../test-sync.sh', import.meta.url).pathname
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
  const dir = mkdtempSync(join(tmpdir(), 'test-sync-'))
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
function run(env, { runs, jobList, after, args = ['feat'], perRun = {}, deploys = [], fail = false, deployChecks }) {
  const bin = join(env.dir, 'bin')
  execFileSync('mkdir', ['-p', bin])
  writeFileSync(join(env.dir, 'runs.json'), JSON.stringify({ workflow_runs: runs }))
  writeFileSync(join(env.dir, 'jobs.json'), JSON.stringify({ jobs: jobList }))
  writeFileSync(join(env.dir, 'deploy.json'), JSON.stringify({ workflow_runs: deploys }))
  if (fail) writeFileSync(join(env.dir, 'fail'), '')
  if (deployChecks) writeFileSync(join(env.dir, 'deploy-checks'), `${deployChecks.join('\n')}\n`)
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
[ -f "${d}/fail" ] && exit 1
case "$*" in
  *"-X POST"*deploy-test.yml/dispatches*) echo "$*" >> "${d}/deploy-dispatched" ;;
  *deploy-test.yml/runs*)
    # With deploy-checks: one push run per distinct test head, numbered 101, 102, ... in push order.
    if [ -f "${d}/deploy-checks" ]; then
      sha=$(echo "$*" | sed 's/.*head_sha=\\([0-9a-f]*\\).*/\\1/')
      grep -qx "$sha" "${d}/heads" 2>/dev/null || echo "$sha" >> "${d}/heads"
      n=$(grep -nx "$sha" "${d}/heads" | cut -d: -f1)
      printf '{"workflow_runs":[{"id":%s,"head_sha":"%s","event":"push","status":"in_progress","created_at":"x"}]}' $((100 + n)) "$sha"
    else cat "${d}/deploy.json"; fi ;;
  *runs/10[0-9]/jobs*)
    id=\${2#*runs/}; n=$((\${id%%/*} - 100))
    c=$(sed -n "\${n}p" "${d}/deploy-checks")
    # A rejected head means main moved after the push: move origin main now, as another merge would.
    if [ "$c" = failure ] && [ ! -f "${d}/advanced-$n" ]; then
      touch "${d}/advanced-$n"
      old=$(git --git-dir "${env.origin}" rev-parse main)
      new=$(git --git-dir "${env.origin}" commit-tree -p "$old" -m "late main" "$old^{tree}")
      git --git-dir "${env.origin}" update-ref refs/heads/main "$new" "$old"
    fi
    printf '{"jobs":[{"name":"Backend images","conclusion":null,"steps":[{"name":"Run scripts/ci-check-test-branch.sh origin","conclusion":"%s"}]}]}' "$c" ;;
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
    env: { ...process.env, ...gitEnv, PATH: `${bin}:${process.env.PATH}`, TEST_SYNC_REPO: 'o/r', TEST_SYNC_POLL: '0', TEST_SYNC_FOLLOW_WAIT: '0' },
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

test('a newer failed rerun outweighs an older passing run', () =>
  withEnv((env) => {
    const before = originTest(env)
    const runs = [runOf(env.feat, { id: 8, created_at: '2026-11-25T01:00:00Z' }), runOf(env.feat)]
    const perRun = { 8: jobs({ 'web-test (2/3)': 'failure' }), 7: jobs() }
    const r = run(env, { runs, jobList: [], perRun })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /run 8: web-test \(2\/3\)/)
    assert.equal(originTest(env), before)
  }))

test('a rerun keeps its id and created_at; the latest started attempt still decides', () =>
  withEnv((env) => {
    const runs = [
      runOf(env.feat, { id: 8, created_at: '2026-11-25T01:00:00Z', run_started_at: '2026-11-25T01:00:00Z' }),
      runOf(env.feat, { id: 7, created_at: '2026-11-25T00:00:00Z', run_started_at: '2026-11-25T02:00:00Z', run_attempt: 2 }),
    ]
    const perRun = { 8: jobs(), 7: jobs({ typecheck: 'failure' }) }
    const r = run(env, { runs, jobList: [], perRun })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /run 7: typecheck/)
  }))

test('works with a relative remote URL', () =>
  withEnv((env) => {
    env.git(env.clone, 'remote', 'set-url', 'origin', '../origin.git')
    const r = run(env, { runs: [runOf(env.feat)], jobList: jobs() })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(contains(env, 'main') && contains(env, 'feat'))
  }))

test('a newest failed run with no passing run is reported by its id', () =>
  withEnv((env) => {
    const runs = [runOf(env.feat, { id: 8, created_at: '2026-11-25T01:00:00Z' }), runOf(env.feat, { status: 'in_progress' })]
    const perRun = { 8: jobs({ build: 'failure' }), 7: jobs({ lint: null }) }
    const r = run(env, { runs, jobList: [], perRun })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /run 8: build/)
  }))

test('merges again when someone else pushed test meanwhile', () =>
  withEnv((env) => {
    // On the first push the hook moves test itself (as another pusher would) and refuses.
    const hook = join(env.origin, 'hooks', 'pre-receive')
    writeFileSync(
      hook,
      `#!/bin/sh
[ -f "${env.dir}/moved" ] && exit 0
touch "${env.dir}/moved"
unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
old=$(git rev-parse test)
new=$(git commit-tree -p "$old" -m other "$old^{tree}")
git update-ref refs/heads/test "$new" "$old"
exit 1
`,
    )
    chmodSync(hook, 0o755)
    const r = run(env, { runs: [runOf(env.feat)], jobList: jobs() })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /test moved to .*\(attempt 1\/5\)/)
    assert.ok(contains(env, 'main') && contains(env, 'feat'))
    assert.match(env.git(env.dir, '--git-dir', env.origin, 'log', '--format=%s', 'test'), /other/)
  }))

test('a push refused for any other reason fails at once', () =>
  withEnv((env) => {
    const hook = join(env.origin, 'hooks', 'pre-receive')
    writeFileSync(hook, '#!/bin/sh\necho protected >&2\nexit 1\n')
    chmodSync(hook, 0o755)
    const r = run(env, { runs: [runOf(env.feat)], jobList: jobs() })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /push to test failed[\s\S]*protected/)
    assert.doesNotMatch(r.stdout, /attempt/)
  }))

test('passes over a format dispatch, whose lint ran after biome --write', () =>
  withEnv((env) => {
    const formatted = jobs().map((j) =>
      j.name === 'lint' ? { ...j, steps: [{ name: 'Apply optional formatting fixes', conclusion: 'success' }] } : j,
    )
    const r = run(env, {
      runs: [runOf(env.feat, { id: 9 })],
      jobList: [],
      perRun: { 9: formatted },
      after: { runs: [runOf(env.feat)], jobList: jobs() },
    })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(existsSync(join(env.dir, 'dispatched')))
  }))

test('names required jobs that a completed run skipped or lacked', () =>
  withEnv((env) => {
    const list = jobs({ build: 'skipped' }).filter((j) => j.name !== 'lint')
    const r = run(env, { runs: [runOf(env.feat)], jobList: list })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /without these required jobs: lint, build[\s\S]*REQUIRED/)
  }))

test('stops after repeated GitHub API failures instead of waiting out the deadline', () =>
  withEnv((env) => {
    const r = run(env, { runs: [], jobList: [], fail: true })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /gh auth status/)
  }))

test('nothing to push: redeploys a commit whose last Deploy test failed', () =>
  withEnv((env) => {
    assert.equal(run(env, { runs: [runOf(env.feat)], jobList: jobs() }).status, 0)
    const sha = originTest(env)
    const r = run(env, {
      runs: [runOf(env.feat)],
      jobList: jobs(),
      deploys: [{ head_sha: sha, status: 'completed', conclusion: 'failure', created_at: '2026-11-25T00:00:00Z' }],
    })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /nothing to push[\s\S]*was failure; dispatched/)
    assert.match(readFileSync(join(env.dir, 'deploy-dispatched'), 'utf8'), /ref=test/)
  }))

test('nothing to push: leaves an already deployed commit alone', () =>
  withEnv((env) => {
    assert.equal(run(env, { runs: [runOf(env.feat)], jobList: jobs() }).status, 0)
    const deploys = [{ head_sha: originTest(env), status: 'completed', conclusion: 'success', created_at: '2026-11-25T00:00:00Z' }]
    const r = run(env, { runs: [runOf(env.feat)], jobList: jobs(), deploys })
    assert.match(r.stdout, /already deployed/)
    assert.ok(!existsSync(join(env.dir, 'deploy-dispatched')))
  }))

test('re-merges when main moved before Deploy test checked the pushed head', () =>
  withEnv((env) => {
    const r = run(env, { runs: [runOf(env.feat)], jobList: jobs(), deployChecks: ['failure', 'success'] })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /main moved before Deploy test started[\s\S]*Deploy test accepted/)
    assert.match(env.git(env.dir, '--git-dir', env.origin, 'log', '--format=%s', 'test'), /late main/)
    assert.ok(contains(env, 'main') && contains(env, 'feat'))
  }))

test('with no branches (or only main/test) it just syncs main, without asking GitHub', () => {
  for (const args of [[], ['main', 'test']]) {
    withEnv((env) => {
      const r = run(env, { runs: [], jobList: [], fail: true, args })
      assert.equal(r.status, 0, r.stderr)
      assert.ok(contains(env, 'main'))
      assert.ok(!contains(env, 'feat'))
    })
  }
})

test('rejects remote-prefixed names and non-numeric options', () =>
  withEnv((env) => {
    assert.equal(run(env, { runs: [], jobList: [], args: ['origin/feat'] }).status, 2)
    assert.equal(run(env, { runs: [], jobList: [], args: ['--wait-ci', 'abc', 'feat'] }).status, 2)
  }))
