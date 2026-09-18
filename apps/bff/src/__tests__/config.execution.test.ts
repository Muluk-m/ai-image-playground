import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

const sourceRoot = resolve(import.meta.dir, '..')

async function importConfig(env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, '-e', 'await import("./config.ts")'], {
    cwd: sourceRoot,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { exitCode, stderr }
}

describe('execution deployment configuration', () => {
  it('rejects a misspelled paused-worker flag at startup', async () => {
    const result = await importConfig({ WORKER_START_PAUSED: 'tru' })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('WORKER_START_PAUSED must be true or false')
  })

  it('rejects executor origins with credentials or paths', async () => {
    const result = await importConfig({ EXECUTOR_ORIGIN: 'http://user:pass@example.com/path' })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('EXECUTOR_ORIGIN must be a bare http(s) origin')
  })
})
