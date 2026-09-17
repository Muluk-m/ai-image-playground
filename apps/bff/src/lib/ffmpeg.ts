import { log } from './logger'

/**
 * 本机的 ffmpeg / ffprobe。**整个 BFF 只在这里 spawn 它们**，所以测试注入这一处就够，
 * 任何用例都不依赖宿主机真装了 ffmpeg。
 *
 * 可用性是**启动探测一次**的结果，不是每次调用现问：每轮为了问一句「你在吗」就 spawn
 * 一个进程，在小机器上是纯浪费。没探测过一律按「不可用」，所以没跑启动探测的进程
 * （测试、脚本、worker）不会意外把依赖它的工具发给模型。
 */

export interface FfmpegRunResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface FfmpegRunner {
  /** `ffmpeg <args>`；`timeoutMs` 到点杀进程并以非零码返回，不抛。 */
  ffmpeg(args: readonly string[], options: FfmpegRunOptions): Promise<FfmpegRunResult>
  /** `ffprobe <args>`；同上。 */
  ffprobe(args: readonly string[], options: FfmpegRunOptions): Promise<FfmpegRunResult>
}

export interface FfmpegRunOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

/** 子进程输出只用来写日志与报错，留个上限免得一条坏命令把内存吃掉。 */
const OUTPUT_MAX_CHARS = 8_000

function clip(text: string): string {
  return text.length > OUTPUT_MAX_CHARS ? `${text.slice(-OUTPUT_MAX_CHARS)}` : text
}

async function spawnTool(
  command: string,
  args: readonly string[],
  options: FfmpegRunOptions,
): Promise<FfmpegRunResult> {
  const child = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const stop = () => {
    child.kill()
  }
  const timer = setTimeout(stop, options.timeoutMs)
  options.signal?.addEventListener('abort', stop, { once: true })
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { code, stdout: clip(stdout), stderr: clip(stderr) }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', stop)
  }
}

const systemRunner: FfmpegRunner = {
  ffmpeg: (args, options) => spawnTool('ffmpeg', args, options),
  ffprobe: (args, options) => spawnTool('ffprobe', args, options),
}

let runner: FfmpegRunner = systemRunner
let available = false

/** 探测用的超时：`-version` 要么立刻回，要么这台机器上就没有它。 */
const PROBE_TIMEOUT_MS = 5_000

export function ffmpegRunner(): FfmpegRunner {
  return runner
}

/** 这个部署此刻拿得到 ffmpeg 吗。没探测过就是拿不到。 */
export function isFfmpegAvailable(): boolean {
  return available
}

/**
 * 启动时探测一次并打日志。缺 ffmpeg 不是错误：那只是这个部署少一个工具，
 * 但它必须看得见，否则「拼接工具怎么不见了」就只能靠猜。
 */
export async function detectFfmpeg(): Promise<boolean> {
  const results = await Promise.all([
    runner.ffmpeg(['-version'], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null),
    runner.ffprobe(['-version'], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null),
  ])
  available = results.every((result) => result !== null && result.code === 0)
  if (available) {
    const version = results[0]?.stdout.split('\n')[0]?.trim() ?? ''
    log.info({ event: 'agent.ffmpeg_ready', version }, 'ffmpeg available')
  } else {
    log.warn(
      { event: 'agent.ffmpeg_missing' },
      'ffmpeg/ffprobe not found; the agent cannot stitch videos',
    )
  }
  return available
}

/** 测试注入点：给 runner 就换实现，`available` 显式声明；不传参恢复真实的那一套并复位。 */
export function setFfmpegForTesting(input?: {
  readonly runner?: FfmpegRunner
  readonly available?: boolean
}): void {
  runner = input?.runner ?? systemRunner
  available = input?.available ?? false
}
