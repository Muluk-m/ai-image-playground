import { afterEach, describe, expect, it } from 'bun:test'

// 只起子进程，一句 SQL 都不发；库名故意不可达，真连上就会立刻炸出来。
process.env.DATABASE_URL = 'postgres://unused/ffmpeg-seam'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.LOG_LEVEL = 'silent'

const {
  _runProcessForTesting,
  FFMPEG_ABANDONED_CODE,
  detectFfmpeg,
  isFfmpegAvailable,
  setFfmpegForTesting,
} = await import('../../lib/ffmpeg')

afterEach(() => {
  setFfmpegForTesting()
})

/** 这个标记还在不在进程表里。用 `ps` 是因为它在 macOS 与 Linux 上都有。 */
async function stillRunning(marker: string): Promise<boolean> {
  const ps = Bun.spawn(['ps', '-A', '-o', 'args='], { stdout: 'pipe', stderr: 'ignore' })
  const listing = await new Response(ps.stdout).text()
  await ps.exited
  return listing
    .split('\n')
    .some((line) => line.includes(marker) && !line.includes('ps -A') && !line.includes('grep'))
}

describe('a child process that will not die', () => {
  it('escalates to SIGKILL and stops waiting, instead of hanging the caller forever', async () => {
    // `trap "" TERM` 的进程收到 SIGTERM 纹丝不动；只发 SIGTERM 再 `await child.exited`
    // 就是永远不返回——调用方的 `finally` 不执行，拼接的那个全局槽就永久占住了。
    const marker = `aip-ffmpeg-seam-${crypto.randomUUID()}`
    const started = Date.now()

    const result = await _runProcessForTesting(
      'sh',
      ['-c', `trap "" TERM; echo ${marker}; sleep 60`],
      { timeoutMs: 200, killGraceMs: 200 },
    )

    expect(Date.now() - started).toBeLessThan(5_000)
    expect(result.code).not.toBe(0)
    // SIGKILL 真的送到了：进程表里已经没有它。
    expect(await stillRunning(marker)).toBe(false)
  }, 30_000)

  it('gives up waiting even when the process survives SIGKILL too', async () => {
    // 假装连 SIGKILL 都杀不掉（D 状态、僵死的挂载）：等待也必须有尽头。
    const hung = new Promise<never>(() => {})
    const result = await _runProcessForTesting('sh', ['-c', 'sleep 60'], {
      timeoutMs: 100,
      killGraceMs: 100,
      // 只等这一件永不完成的事，模拟「进程不退、管道不关」。
      waitForTesting: hung,
    })
    expect(result.code).toBe(FFMPEG_ABANDONED_CODE)
    expect(result.stderr).toContain('did not exit')
  }, 30_000)

  it('kills the child as soon as the turn is cancelled', async () => {
    const marker = `aip-ffmpeg-abort-${crypto.randomUUID()}`
    const controller = new AbortController()
    const started = Date.now()
    setTimeout(() => controller.abort(), 100)

    const result = await _runProcessForTesting(
      'sh',
      ['-c', `trap "" TERM; echo ${marker}; sleep 60`],
      { timeoutMs: 60_000, killGraceMs: 200, signal: controller.signal },
    )

    expect(Date.now() - started).toBeLessThan(5_000)
    expect(result.code).not.toBe(0)
    expect(await stillRunning(marker)).toBe(false)
  }, 30_000)

  it('returns an ordinary result when the command simply works', async () => {
    const result = await _runProcessForTesting('sh', ['-c', 'echo hello'], { timeoutMs: 5_000 })
    expect(result).toMatchObject({ code: 0 })
    expect(result.stdout.trim()).toBe('hello')
  }, 30_000)
})

describe('the startup probe', () => {
  it('answers once and never flips the answer mid-process', async () => {
    let probes = 0
    setFfmpegForTesting({
      available: false,
      runner: {
        async ffmpeg() {
          probes++
          return { code: 0, stdout: 'ffmpeg version test', stderr: '' }
        },
        async ffprobe() {
          probes++
          return { code: 0, stdout: 'ffprobe version test', stderr: '' }
        },
      },
    })

    expect(isFfmpegAvailable()).toBe(false)
    expect(await detectFfmpeg()).toBe(true)
    expect(isFfmpegAvailable()).toBe(true)
    // 第二次问不再探：一个进程里这个答案只有一个，否则预扣估算读到的清单
    // 与真正发出去的清单会不一样。
    expect(await detectFfmpeg()).toBe(true)
    expect(probes).toBe(2)
  })

  it('does not hold up the server when the binary hangs on -version', async () => {
    const started = Date.now()
    setFfmpegForTesting({
      available: false,
      runner: {
        ffmpeg: () => new Promise(() => {}),
        ffprobe: () => new Promise(() => {}),
      },
    })

    expect(await detectFfmpeg({ deadlineMs: 300 })).toBe(false)
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(isFfmpegAvailable()).toBe(false)
  }, 30_000)
})
