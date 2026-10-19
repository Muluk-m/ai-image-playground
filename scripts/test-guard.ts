/**
 * Keeps test runs from exhausting a resource-constrained workstation.
 *
 * A machine opts in by creating `$XDG_CONFIG_HOME/test-guard/constrained` (default
 * `~/.config/test-guard/constrained`); nothing about the machine is committed here. CI,
 * Codex Cloud and macmini2 have no marker and keep their current behaviour. On a marked machine:
 * - a run without explicit test files (a full suite) is refused, with where to run it instead;
 * - a targeted run uses one worker and runs files serially;
 * - only one test run happens at a time across every repository using this lock; later runs wait.
 *
 * Imported by the Vitest configs and `run-bun-tests-isolated.ts`, so every entry point
 * (`pnpm test`, `npx vitest`, turbo) passes through it. `node scripts/test-guard.ts suite` guards
 * commands that are always full suites.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
export const CONSTRAINED_MARKER = join(configHome, 'test-guard', 'constrained')
const LOCK_DIR = join(cacheHome, 'test-guard', 'run.lock')
/** Child processes of a run that already holds the lock must not wait for themselves. */
const HELD = 'TEST_GUARD_HELD'
const LOCK_WAIT_MS = Number(process.env.TEST_GUARD_WAIT_MS ?? 15 * 60_000)

const REMOTE_HINT =
  '全量测试请交给远端：rmake -c "pnpm test"（macmini2），或推分支让 CI 跑；本机只跑指定文件，例如 ' +
  'pnpm --dir apps/web exec vitest run src/__tests__/xxx.test.ts，或 pnpm test -- --filter <路径片段>（Bun 包）。'

export function isConstrainedHost(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CI) return false
  return existsSync(CONSTRAINED_MARKER)
}

/** Vitest flags that take a separate value, so the value is not mistaken for a test file. */
const VALUE_FLAGS = new Set([
  '-c',
  '--config',
  '-r',
  '--root',
  '--dir',
  '--project',
  '--pool',
  '--environment',
  '--reporter',
  '--outputFile',
  '--maxWorkers',
  '--minWorkers',
  '--shard',
  '--mode',
  '-t',
  '--testNamePattern',
  '--exclude',
])
const COMMANDS = new Set(['run', 'watch', 'dev', 'related', 'bench'])

/** File filters passed on the Vitest command line; a name filter alone still collects every file. */
export function vitestFileFilters(argv: readonly string[] = process.argv.slice(2)): string[] {
  const filters: string[] = []
  let index = 0
  while (index < argv.length && COMMANDS.has(argv[index]!)) index++
  for (; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--') continue
    if (arg.startsWith('-')) {
      if (VALUE_FLAGS.has(arg)) index++
      continue
    }
    filters.push(arg)
  }
  return filters
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sleep(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Takes the machine-wide test lock, waiting for the run that holds it. Released on exit. */
export function acquireTestLock(label: string): void {
  if (process.env[HELD]) return
  mkdirSync(join(LOCK_DIR, '..'), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  let announced = false
  for (;;) {
    try {
      mkdirSync(LOCK_DIR)
      writeFileSync(join(LOCK_DIR, 'owner'), `${process.pid}\n${label}\n${process.cwd()}\n`)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let owner = ''
      try {
        owner = readFileSync(join(LOCK_DIR, 'owner'), 'utf8')
      } catch {}
      const pid = Number(owner.split('\n')[0])
      // A crashed run leaves its directory behind; a missing or dead owner frees the lock.
      if (!pid || !alive(pid)) {
        rmSync(LOCK_DIR, { recursive: true, force: true })
        continue
      }
      if (Date.now() > deadline)
        throw new Error(
          `test-guard: 另一组测试仍在运行（${owner.split('\n').slice(1, 3).join(' @ ')}），等待超时。`,
        )
      if (!announced) {
        console.error(`test-guard: 等待另一组测试结束（pid ${pid}）…`)
        announced = true
      }
      sleep(2000)
    }
  }
  process.env[HELD] = '1'
  const release = () => {
    try {
      if (readFileSync(join(LOCK_DIR, 'owner'), 'utf8').startsWith(`${process.pid}\n`))
        rmSync(LOCK_DIR, { recursive: true, force: true })
    } catch {}
  }
  process.once('exit', release)
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      release()
      process.exit(130)
    })
}

/** Refuses a full suite on a constrained machine. */
export function refuseFullSuite(what: string): never {
  throw new Error(
    `test-guard: 这台机器标记为资源受限（${CONSTRAINED_MARKER}），不运行${what}。${REMOTE_HINT}`,
  )
}

/**
 * Vitest `test` options for this machine. Only applies while Vitest itself is loading the
 * config, never to `vite build` or the dev server that share the file.
 */
export function vitestGuard(label: string) {
  if (!process.env.VITEST || !isConstrainedHost()) return {}
  if (vitestFileFilters().length === 0) refuseFullSuite(`${label} 的全量 Vitest`)
  acquireTestLock(label)
  return { maxWorkers: 1, fileParallelism: false }
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv[2] === 'suite') {
  if (isConstrainedHost()) {
    try {
      refuseFullSuite('全仓测试')
    } catch (error) {
      console.error((error as Error).message)
      process.exit(1)
    }
  }
}
