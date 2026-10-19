import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const guardPath = fileURLToPath(new URL('../test-guard.ts', import.meta.url))
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
  ...extra,
})

test('finds test files on the Vitest command line but not flag values or name filters', () => {
  assert.deepEqual(guard.vitestFileFilters(['run']), [])
  assert.deepEqual(guard.vitestFileFilters(['run', '-t', 'only this name']), [])
  assert.deepEqual(guard.vitestFileFilters(['run', '--pool', 'threads', '--maxWorkers=1']), [])
  assert.deepEqual(
    guard.vitestFileFilters(['run', 'src/a.test.ts', '--project', 'web', '--', 'src/b.test.ts']),
    ['src/a.test.ts', 'src/b.test.ts'],
  )
  assert.deepEqual(guard.vitestFileFilters(['related', 'src/lib/a.ts']), ['src/lib/a.ts'])
})

test('only a marked machine outside CI is constrained', () => {
  assert.equal(guard.isConstrainedHost({}), false)
  mark()
  assert.equal(guard.isConstrainedHost({}), true)
  assert.equal(guard.isConstrainedHost({ CI: 'true' }), false)
})

test('the suite command refuses on a marked machine and passes elsewhere', () => {
  mark()
  const refused = spawnSync(process.execPath, [guardPath, 'suite'], { env: env(), encoding: 'utf8' })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /rmake/)
  const ci = spawnSync(process.execPath, [guardPath, 'suite'], { env: env({ CI: 'true' }) })
  assert.equal(ci.status, 0)
})

test('a second run waits for the first and a crashed holder does not block forever', async () => {
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const g = await import(${JSON.stringify(guardPath)}); g.acquireTestLock('holder'); ` +
        `console.log('held'); setTimeout(() => {}, 1500)`,
    ],
    { env: env(), stdio: ['ignore', 'pipe', 'inherit'] },
  )
  await new Promise((resolve) => holder.stdout.once('data', resolve))
  const started = Date.now()
  const waiter = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const g = await import(${JSON.stringify(guardPath)}); g.acquireTestLock('waiter')`,
    ],
    { env: env(), encoding: 'utf8' },
  )
  assert.equal(waiter.status, 0, waiter.stderr)
  assert.ok(Date.now() - started >= 900, 'waited for the holder')
  assert.match(waiter.stderr, /等待另一组测试结束/)

  // 进程被强杀后留下的锁：owner 已不存在，下一次直接接手。
  const lock = join(cache, 'test-guard', 'run.lock')
  mkdirSync(lock, { recursive: true })
  writeFileSync(join(lock, 'owner'), '999999\nghost\n/\n')
  const stale = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const g = await import(${JSON.stringify(guardPath)}); g.acquireTestLock('next')`,
    ],
    { env: env({ TEST_GUARD_WAIT_MS: '1000' }), encoding: 'utf8' },
  )
  assert.equal(stale.status, 0, stale.stderr)
})
