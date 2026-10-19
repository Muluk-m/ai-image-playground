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
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
export const CONSTRAINED_MARKER = join(configHome, 'test-guard', 'constrained')
const LOCK_ROOT = join(cacheHome, 'test-guard')
const LOCK = join(LOCK_ROOT, 'run.lock')
const RECLAIM = join(LOCK_ROOT, 'reclaim.lock')
/** Child processes of a run that already holds the lock must not wait for themselves. */
const HELD = 'TEST_GUARD_HELD'
const LOCK_WAIT_MS = Number(process.env.TEST_GUARD_WAIT_MS ?? 15 * 60_000)
const POLL_MS = 500
/** A reclaimer that died mid-reclaim must not block everyone; reclaiming takes milliseconds. */
const RECLAIM_STALE_MS = 10_000

const REMOTE_HINT =
  '全量测试请交给远端：rmake -c "pnpm test"（macmini2），或推分支让 CI 跑；本机只跑指定文件，例如 ' +
  'pnpm --dir apps/web exec vitest run src/__tests__/xxx.test.ts，或 pnpm test -- --filter <路径片段>（Bun 包）。'

export function isConstrainedHost(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CI) return false
  return existsSync(CONSTRAINED_MARKER)
}

type ParseCli = (
  argv: string[],
  config?: { allowUnknownOptions?: boolean },
) => { filter: string[]; options: { related?: string[] | string } }

/** Whether a Vitest command line names test files; Vitest's own parser decides what is a value. */
export function vitestHasFileFilters(parse: ParseCli, argv: readonly string[]): boolean {
  const { filter, options } = parse(['vitest', ...argv], { allowUnknownOptions: true })
  const related = Array.isArray(options.related) ? options.related.length > 0 : !!options.related
  return filter.length > 0 || related
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

/**
 * Creates `path` holding `content` in one step: the content is written to a private file first
 * and hard-linked into place, so no process ever sees the lock without its owner.
 */
function createWithContent(path: string, content: string): boolean {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`
  writeFileSync(temp, content)
  try {
    linkSync(temp, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally {
    unlinkSync(temp)
  }
}

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Removes a lock whose owner died, unless someone replaced it since `seen` was read. */
function reclaim(seen: string): void {
  const stamp = `${process.pid}\n`
  if (!createWithContent(RECLAIM, stamp)) {
    try {
      if (Date.now() - statSync(RECLAIM).mtimeMs > RECLAIM_STALE_MS) unlinkSync(RECLAIM)
    } catch {}
    return
  }
  try {
    // Only the reclaimer touches a dead lock, and only the exact one it judged dead.
    if (read(LOCK) === seen) unlinkSync(LOCK)
  } finally {
    if (read(RECLAIM) === stamp) unlinkSync(RECLAIM)
  }
}

/** Takes the machine-wide test lock, waiting for the run that holds it. Released on exit. */
export function acquireTestLock(label: string): void {
  if (process.env[HELD]) return
  mkdirSync(LOCK_ROOT, { recursive: true })
  const owner = `${process.pid}\n${label}\n${process.cwd()}\n`
  const deadline = Date.now() + LOCK_WAIT_MS
  let announced = false
  while (!createWithContent(LOCK, owner)) {
    const seen = read(LOCK)
    if (seen === null) continue
    const pid = Number(seen.split('\n')[0])
    if (!pid || !alive(pid)) {
      reclaim(seen)
      continue
    }
    if (Date.now() > deadline)
      throw new Error(
        `test-guard: 另一组测试仍在运行（${seen.split('\n').slice(1, 3).join(' @ ')}），等待超时。`,
      )
    if (!announced) {
      console.error(`test-guard: 等待另一组测试结束（pid ${pid}）…`)
      announced = true
    }
    sleep(POLL_MS)
  }
  process.env[HELD] = '1'
  // Released only when this process really ends; a run that is still stopping its children keeps
  // the lock. A run killed outright leaves the file, and the next run reclaims it by PID.
  process.once('exit', () => {
    if (read(LOCK) === owner) unlinkSync(LOCK)
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
export function vitestGuard(label: string, parse: ParseCli) {
  if (!process.env.VITEST || !isConstrainedHost()) return {}
  if (!vitestHasFileFilters(parse, process.argv.slice(2))) refuseFullSuite(`${label} 的全量 Vitest`)
  acquireTestLock(label)
  return { maxWorkers: 1, fileParallelism: false }
}

function entryPath(): string {
  try {
    return process.argv[1] ? realpathSync(process.argv[1]) : ''
  } catch {
    return ''
  }
}
if (entryPath() === realpathSync(fileURLToPath(import.meta.url)) && process.argv[2] === 'suite') {
  if (isConstrainedHost()) {
    try {
      refuseFullSuite('全仓测试')
    } catch (error) {
      console.error((error as Error).message)
      process.exit(1)
    }
  }
}
