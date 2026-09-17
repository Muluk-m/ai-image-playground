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
  /** `ffmpeg <args>`；超时或取消都杀进程并以非零码返回，**绝不无限等**。 */
  ffmpeg(args: readonly string[], options: FfmpegRunOptions): Promise<FfmpegRunResult>
  /** `ffprobe <args>`；同上。 */
  ffprobe(args: readonly string[], options: FfmpegRunOptions): Promise<FfmpegRunResult>
}

export interface FfmpegRunOptions {
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  /** SIGTERM 之后等多久升级 SIGKILL；再等同样久就彻底不等了。默认 5 秒。 */
  readonly killGraceMs?: number
}

/**
 * 「杀了也没等到它退」的退出码。它必须是个失败码：调用方据此收场、释放资源，
 * 而不是把自己挂在一个永远不会 resolve 的 promise 上。
 */
export const FFMPEG_ABANDONED_CODE = -1

/** 子进程输出只用来写日志与报错，留个上限免得一条坏命令把内存吃掉。 */
const OUTPUT_MAX_CHARS = 8_000

/** SIGTERM 之后给它这么久收拾，然后 SIGKILL；再这么久还没退就不等了。 */
const DEFAULT_KILL_GRACE_MS = 5_000

/** 启动探测最多占用的时间。它挡在 `app.listen` 前面，不能让一条挂住的二进制拖着服务不起。 */
const DEFAULT_PROBE_DEADLINE_MS = 2_000

function clip(text: string): string {
  return text.length > OUTPUT_MAX_CHARS ? `${text.slice(-OUTPUT_MAX_CHARS)}` : text
}

interface SpawnOptions extends FfmpegRunOptions {
  /** 测试注入：拿一件永不完成的事替换「等子进程退出」，模拟连 SIGKILL 都杀不掉。 */
  readonly waitForTesting?: Promise<never>
}

/**
 * 起一个子进程并等它跑完，**等待一定有尽头**。三段式收场：
 * 超时或取消 → SIGTERM → 宽限后 SIGKILL → 再宽限还没退就放弃等待、按失败返回。
 *
 * 最后那一段不是多余的保险：`await child.exited` 在进程不退时永远不 resolve，
 * 调用方的 `finally` 就不执行——拼接那个全局槽会被永久占住，只能重启 BFF。
 */
async function spawnTool(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<FfmpegRunResult> {
  const grace = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const child = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const timers: ReturnType<typeof setTimeout>[] = []
  let abandon: (() => void) | undefined
  const abandoned = new Promise<null>((resolve) => {
    abandon = () => resolve(null)
  })
  let escalated = false
  const escalate = () => {
    if (escalated) return
    escalated = true
    child.kill('SIGTERM')
    timers.push(setTimeout(() => child.kill('SIGKILL'), grace))
    timers.push(setTimeout(() => abandon?.(), grace * 2))
  }
  timers.push(setTimeout(escalate, options.timeoutMs))
  options.signal?.addEventListener('abort', escalate, { once: true })

  const finished = (async (): Promise<FfmpegRunResult> => {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      options.waitForTesting ?? child.exited,
    ])
    return { code: code ?? FFMPEG_ABANDONED_CODE, stdout: clip(stdout), stderr: clip(stderr) }
  })()
  // 放弃等待之后这条仍然挂着，别让它变成一次 unhandled rejection。
  finished.catch(() => {})

  try {
    return (
      (await Promise.race([finished, abandoned])) ?? {
        code: FFMPEG_ABANDONED_CODE,
        stdout: '',
        stderr: `${command} did not exit after SIGTERM and SIGKILL`,
      }
    )
  } finally {
    for (const timer of timers) clearTimeout(timer)
    options.signal?.removeEventListener('abort', escalate)
  }
}

const systemRunner: FfmpegRunner = {
  ffmpeg: (args, options) => spawnTool('ffmpeg', args, options),
  ffprobe: (args, options) => spawnTool('ffprobe', args, options),
}

let runner: FfmpegRunner = systemRunner
let available = false
let probed: Promise<boolean> | null = null

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
 *
 * **一个进程里只探一次**，之后这个答案不再变：起轮前的预扣估算与真正发给模型的清单
 * 是两个时刻读同一个标志，中途翻面就会出现「按 4 个工具预扣、按 5 个工具发」。
 * 探测整体还有一个 deadline——它挡在 `app.listen` 前面，一条挂住的二进制不能拖着服务不起。
 */
export function detectFfmpeg(options: { readonly deadlineMs?: number } = {}): Promise<boolean> {
  probed ??= probe(options.deadlineMs ?? DEFAULT_PROBE_DEADLINE_MS)
  return probed
}

async function probe(deadlineMs: number): Promise<boolean> {
  const version = ['-version']
  const call = { timeoutMs: deadlineMs }
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), deadlineMs))
  const answers = Promise.all([
    runner.ffmpeg(version, call).catch(() => null),
    runner.ffprobe(version, call).catch(() => null),
  ])
  answers.catch(() => {})
  const results = await Promise.race([answers, timeout])
  available = results !== null && results.every((result) => result?.code === 0)
  if (available) {
    const version = results?.[0]?.stdout.split('\n')[0]?.trim() ?? ''
    log.info({ event: 'agent.ffmpeg_ready', version }, 'ffmpeg available')
  } else {
    log.warn(
      { event: 'agent.ffmpeg_missing', timedOut: results === null },
      'ffmpeg/ffprobe not usable; the agent cannot stitch videos',
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
  probed = null
}

/** 测试注入点：这是唯一一处 spawn，测「杀不死的子进程」只能从这里进。 */
export function _runProcessForTesting(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<FfmpegRunResult> {
  return spawnTool(command, args, options)
}
