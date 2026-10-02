/**
 * Runs every Bun test file under the given roots in its own process.
 *
 * Database-backed suites pin module singletons (DATABASE_URL, operator config, the Elysia app) to
 * the first database they see, so two files must never share a process.
 *
 *   bun run scripts/run-bun-tests-isolated.ts [--jobs N] [--filter SUBSTRING] <root>...
 *
 * --jobs (or BUN_TEST_JOBS) runs N files at once; the default is 1 so a local `pnpm test` stays
 * single-worker. Every suite gets its own database, so parallel runs do not share data.
 * --filter keeps only files whose path contains the substring.
 *
 * All files run even after a failure; the summary at the end lists every failed file.
 */
import { relative } from 'node:path'

const roots: string[] = []
let jobs = Number(process.env.BUN_TEST_JOBS ?? 1)
let filter: string | undefined
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index++) {
  const arg = args[index]
  if (arg === '--jobs' || arg === '-j') jobs = Number(args[++index])
  else if (arg === '--filter') filter = args[++index]
  else roots.push(arg)
}
if (roots.length === 0) throw new Error('Pass at least one test root')
if (!Number.isInteger(jobs) || jobs < 1) throw new Error('--jobs must be a positive integer')

const testFiles: string[] = []
const glob = new Bun.Glob('**/*.test.{ts,tsx}')
for (const root of roots) {
  for await (const file of glob.scan({ cwd: root, absolute: true, onlyFiles: true })) {
    if (!filter || file.includes(filter)) testFiles.push(file)
  }
}
testFiles.sort()

if (testFiles.length === 0) {
  throw new Error(
    `No Bun test files found under: ${roots.join(', ')}${filter ? ` matching "${filter}"` : ''}`,
  )
}

type Result = { file: string; exitCode: number; seconds: number; output: string }

async function runFile(file: string): Promise<Result> {
  const started = performance.now()
  // Serial runs stream straight to the terminal; parallel runs buffer each file so outputs do
  // not interleave.
  const streamed = jobs === 1
  const child = Bun.spawn([process.execPath, 'test', file], {
    cwd: process.cwd(),
    env: process.env,
    stdout: streamed ? 'inherit' : 'pipe',
    stderr: streamed ? 'inherit' : 'pipe',
    stdin: 'ignore',
  })
  const output = streamed
    ? ''
    : (
        await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      ).join('')
  const exitCode = await child.exited
  return { file, exitCode, seconds: (performance.now() - started) / 1000, output }
}

const results: Result[] = []
let next = 0
async function worker(): Promise<void> {
  while (next < testFiles.length) {
    const result = await runFile(testFiles[next++])
    if (jobs > 1) process.stdout.write(result.output)
    results.push(result)
  }
}
const started = performance.now()
await Promise.all(Array.from({ length: Math.min(jobs, testFiles.length) }, worker))

const failed = results
  .filter((result) => result.exitCode !== 0)
  .sort((a, b) => a.file.localeCompare(b.file))
const slowest = [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 5)
const label = (result: Result) =>
  `${relative(process.cwd(), result.file)} (${result.seconds.toFixed(1)}s)`

console.log(
  `\n${results.length - failed.length}/${results.length} test files passed in ` +
    `${((performance.now() - started) / 1000).toFixed(1)}s with ${jobs} job(s).`,
)
console.log(`Slowest: ${slowest.map(label).join(', ')}`)
if (failed.length > 0) {
  console.error(`\nFailed test files (${failed.length}):`)
  for (const result of failed) console.error(`  ✗ ${label(result)} exit ${result.exitCode}`)
  process.exit(1)
}
