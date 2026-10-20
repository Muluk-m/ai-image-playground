import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const guardPath = fileURLToPath(new URL('../test-guard.ts', import.meta.url))
const { parseCLI } = await import(
  new URL('../../apps/web/node_modules/vitest/dist/node.js', import.meta.url).href
)
const home = mkdtempSync(join(tmpdir(), 'test-guard-'))
const config = join(home, 'config')
const cache = join(home, 'cache')
process.env.XDG_CONFIG_HOME = config
process.env.XDG_CACHE_HOME = cache
delete process.env.CI
const guard = await import(guardPath)
after(() => rmSync(home, { recursive: true, force: true }))

const mark = () => {
  mkdirSync(join(config, 'test-guard'), { recursive: true })
  writeFileSync(guard.CONSTRAINED_MARKER, '')
}
const env = (extra = {}) => ({
  ...process.env,
  XDG_CONFIG_HOME: config,
  XDG_CACHE_HOME: cache,
  CI: '',
  TEST_GUARD_HELD: '',
  ...extra,
})
const lockFile = join(cache, 'test-guard', 'run-owner')

/** Starts a process that takes the lock, records when it held it, and releases it on exit. */
function contender(log, name, holdMs = 300) {
  const script =
    `const g = await import(${JSON.stringify(guardPath)});` +
    `const fs = await import('node:fs');` +
    `g.acquireTestLock(${JSON.stringify(name)});` +
    `const start = Date.now();` +
    `await new Promise((r) => setTimeout(r, ${holdMs}));` +
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ start, end: Date.now() }) + '\\n');`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: env(),
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  return new Promise((resolve) => child.on('exit', (code) => resolve({ code, stderr })))
}

function assertSerial(log, count) {
  const spans = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .sort((a, b) => a.start - b.start)
  assert.equal(spans.length, count)
  for (let index = 1; index < spans.length; index++)
    assert.ok(spans[index].start >= spans[index - 1].end, 'two runs held the lock at once')
}

test('uses the Vitest parser to tell test files from option values', () => {
  const has = (argv) => guard.vitestHasFileFilters(parseCLI, argv)
  assert.equal(has(['run']), false)
  assert.equal(has(['run', '-t', 'only this name']), false)
  assert.equal(has(['run', '--testTimeout', '10000', '--hookTimeout', '5000']), false)
  assert.equal(has(['run', '--pool', 'threads', '--maxWorkers=1']), false)
  assert.equal(has(['run', 'src/a.test.ts', '--project', 'web']), true)
  assert.equal(has(['related', 'src/lib/a.ts']), true)
})

test('only a marked machine outside CI is constrained', () => {
  assert.equal(guard.isConstrainedHost({}), false)
  mark()
  assert.equal(guard.isConstrainedHost({}), true)
  assert.equal(guard.isConstrainedHost({ CI: 'true' }), false)
})

test('the suite command refuses on a marked machine, from any checkout path', () => {
  mark()
  const odd = join(home, 'repo with space 中文 #1', 'scripts')
  mkdirSync(odd, { recursive: true })
  copyFileSync(guardPath, join(odd, 'test-guard.ts'))
  for (const path of [guardPath, join(odd, 'test-guard.ts')]) {
    const refused = spawnSync(process.execPath, [path, 'suite'], { env: env(), encoding: 'utf8' })
    assert.equal(refused.status, 1, path)
    assert.match(refused.stderr, /rmake/)
  }
  const ci = spawnSync(process.execPath, [guardPath, 'suite'], { env: env({ CI: 'true' }) })
  assert.equal(ci.status, 0)
})

test('runs that start together hold the lock one after another', async () => {
  const log = join(home, 'together.log')
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, index) => contender(log, `run-${index}`)),
  )
  for (const result of results) assert.equal(result.code, 0, result.stderr)
  assertSerial(log, 4)
})

test('several waiters reclaim a crashed run without overlapping', async () => {
  mkdirSync(join(cache, 'test-guard'), { recursive: true })
  writeFileSync(lockFile, '999999\nghost\n/\n')
  const log = join(home, 'reclaim.log')
  const results = await Promise.all(
    Array.from({ length: 3 }, (_, index) => contender(log, `waiter-${index}`, 200)),
  )
  for (const result of results) assert.equal(result.code, 0, result.stderr)
  assertSerial(log, 3)
})

test('an unreadable lock is waited on with the deadline, not spun on', () => {
  const blocker = join(cache, 'test-guard', 'run-owner')
  rmSync(blocker, { recursive: true, force: true })
  mkdirSync(blocker, { recursive: true })
  const started = Date.now()
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const g = await import(${JSON.stringify(guardPath)}); g.acquireTestLock('stuck')`,
    ],
    { env: env({ TEST_GUARD_WAIT_MS: '1200' }), encoding: 'utf8', timeout: 10_000 },
  )
  rmSync(blocker, { recursive: true, force: true })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /等待超时/)
  assert.ok(Date.now() - started < 8_000)
})
