/**
 * 「这几段要怎么接」的全部算式，纯函数，不碰进程也不碰数据库。
 *
 * 分开放是因为它才是这件事里真正会算错的部分：不同模型出的片编码、分辨率、帧率、有没有
 * 音轨都可能不同，`-c copy` 在不一致时不会报错、只会产出一条各家播放器表现不同的坏片。
 * 所以默认一律重编码，而重编码的参数怎么拼由这里单测钉住。
 */

/** 一段输入片的真实参数，由 ffprobe 读出来。 */
export interface StitchProbe {
  readonly width: number
  readonly height: number
  readonly durationSeconds: number
  readonly fps: number
  readonly hasAudio: boolean
}

/** 成片的参数。分辨率取第一段——用户要的是「把我这几镜接起来」，不是「换一个画幅」。 */
export interface StitchTarget {
  readonly width: number
  readonly height: number
  readonly fps: number
  /** 只要有一段有声音，成片就带音轨，没声音的那几段补等长静音。全都没有就不要音轨。 */
  readonly withAudio: boolean
  /** 需要补静音轨时那路 `anullsrc` 输入的下标；不需要就是 undefined。 */
  readonly silentInputIndex?: number
}

/** 某一段为了接进成片被怎么动过。逐条如实写进工具回执，用户与模型都看得见。 */
export interface StitchAdaptation {
  readonly index: number
  /** 分辨率与成片不同，被缩放过。 */
  readonly scaled: boolean
  /** 画幅与成片不同，补了黑边（letterbox / pillarbox）。 */
  readonly padded: boolean
  /** 本来没有音轨，补了等长静音。 */
  readonly silenced: boolean
}

/** 一次拼接的资源上限。VPS 是小机器，这三个数字是它扛得住的那条线。 */
export const STITCH_LIMITS = {
  minSegments: 2,
  maxSegments: 8,
  maxTotalSeconds: 180,
  /** 单次 ffmpeg 的墙钟上限；到点杀进程。 */
  timeoutMs: 300_000,
} as const

const FPS_MIN = 1
const FPS_MAX = 60
const FPS_FALLBACK = 24

/** ffprobe 的 `r_frame_rate` 是 `30000/1001` 这种分数；除不动就当没读到。 */
export function parseFrameRate(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const [numerator, denominator] = value.split('/')
  const top = Number(numerator)
  const bottom = denominator === undefined ? 1 : Number(denominator)
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return null
  const fps = top / bottom
  return fps > 0 ? fps : null
}

interface ProbeStream {
  readonly codec_type?: string
  readonly width?: number
  readonly height?: number
  readonly duration?: string | number
  readonly r_frame_rate?: string
  readonly avg_frame_rate?: string
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * `ffprobe -print_format json -show_streams -show_format` 的输出 → 我们要的那五项。
 * 读不出视频流、宽高或时长就是 null：那一段接不进去，得让模型知道是哪一段。
 */
export function parseStitchProbe(stdout: string): StitchProbe | null {
  let payload: { streams?: ProbeStream[]; format?: { duration?: string | number } }
  try {
    payload = JSON.parse(stdout) as typeof payload
  } catch {
    return null
  }
  const streams = payload.streams ?? []
  const video = streams.find((stream) => stream.codec_type === 'video')
  if (!video) return null
  const width = numeric(video.width)
  const height = numeric(video.height)
  const duration = numeric(video.duration) ?? numeric(payload.format?.duration)
  if (!width || !height || !duration) return null
  const fps = parseFrameRate(video.r_frame_rate) ?? parseFrameRate(video.avg_frame_rate)
  return {
    width: Math.round(width),
    height: Math.round(height),
    durationSeconds: duration,
    fps: fps ?? FPS_FALLBACK,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
  }
}

/** libx264 要偶数宽高；奇数分辨率的输入按下取偶，差的那一行像素比编码失败便宜。 */
function even(value: number): number {
  return Math.max(2, value - (value % 2))
}

export function stitchTarget(probes: readonly StitchProbe[]): StitchTarget {
  const first = probes[0]
  if (!first) throw new Error('没有可拼接的片段')
  const withAudio = probes.some((probe) => probe.hasAudio)
  const needsSilence = withAudio && probes.some((probe) => !probe.hasAudio)
  return {
    width: even(first.width),
    height: even(first.height),
    fps: Math.min(FPS_MAX, Math.max(FPS_MIN, Math.round(first.fps) || FPS_FALLBACK)),
    withAudio,
    // 静音那路是最后一个输入：前面的下标必须与 `-i` 的顺序逐一对应。
    ...(needsSilence ? { silentInputIndex: probes.length } : {}),
  }
}

/** 画幅一样才只缩放；不一样就要补边，这是两件不同的事，回执里分开说。 */
function aspectDiffers(probe: StitchProbe, target: StitchTarget): boolean {
  // 逐像素比例相乘再比，避免除法在 16:9 与 1.7777 之间纠缠。
  return probe.width * target.height !== target.width * probe.height
}

export function stitchAdaptations(
  probes: readonly StitchProbe[],
  target: StitchTarget,
): StitchAdaptation[] {
  return probes.map((probe, index) => ({
    index,
    scaled: probe.width !== target.width || probe.height !== target.height,
    padded: aspectDiffers(probe, target),
    silenced: target.withAudio && !probe.hasAudio,
  }))
}

/**
 * 逐段归一再 `concat`。每一段都走 scale → pad → setsar → fps → format，
 * 少任何一步都可能让 concat 因为「输入参数不一致」拒绝，或者产出一条画面被拉伸的片子。
 */
export function stitchFilterGraph(probes: readonly StitchProbe[], target: StitchTarget): string {
  const { width: w, height: h } = target
  const chains: string[] = []
  for (const [index, probe] of probes.entries()) {
    chains.push(
      `[${index}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${target.fps},` +
        `format=yuv420p[v${index}]`,
    )
    if (!target.withAudio) continue
    chains.push(
      probe.hasAudio
        ? `[${index}:a]aresample=async=1:first_pts=0,` +
            `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${index}]`
        : `[${target.silentInputIndex}:a]atrim=0:${probe.durationSeconds.toFixed(3)},` +
            `asetpts=PTS-STARTPTS,` +
            `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${index}]`,
    )
  }
  const pairs = probes
    .map((_, index) => (target.withAudio ? `[v${index}][a${index}]` : `[v${index}]`))
    .join('')
  chains.push(
    `${pairs}concat=n=${probes.length}:v=1:a=${target.withAudio ? 1 : 0}[outv]` +
      (target.withAudio ? '[outa]' : ''),
  )
  return chains.join(';')
}

export function stitchFfmpegArgs(input: {
  readonly inputPaths: readonly string[]
  readonly probes: readonly StitchProbe[]
  readonly target: StitchTarget
  readonly outputPath: string
}): string[] {
  const { inputPaths, probes, target, outputPath } = input
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    ...inputPaths.flatMap((path) => ['-i', path]),
    // 无限长的静音源；每一段各自 atrim 到自己的长度，所以它不会拖长成片。
    ...(target.silentInputIndex !== undefined
      ? ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']
      : []),
    '-filter_complex',
    stitchFilterGraph(probes, target),
    '-map',
    '[outv]',
    ...(target.withAudio ? ['-map', '[outa]'] : []),
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    // 网页播放器边下边播要靠它，否则整份 mp4 下完才起播。
    '-movflags',
    '+faststart',
    ...(target.withAudio ? ['-c:a', 'aac', '-b:a', '128k'] : []),
    outputPath,
  ]
}

export function stitchProbeArgs(path: string): string[] {
  return ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path]
}

/** 上限检查。触到上限不是异常，是一条要如实转达给用户的话。 */
export function stitchLimitRefusal(probes: readonly StitchProbe[]): string | null {
  if (probes.length < STITCH_LIMITS.minSegments) {
    return `拼接至少要 ${STITCH_LIMITS.minSegments} 段视频，这次只有 ${probes.length} 段。`
  }
  if (probes.length > STITCH_LIMITS.maxSegments) {
    return `一次最多拼 ${STITCH_LIMITS.maxSegments} 段，这次给了 ${probes.length} 段。分批拼，再把成片接起来。`
  }
  const total = probes.reduce((sum, probe) => sum + probe.durationSeconds, 0)
  if (total > STITCH_LIMITS.maxTotalSeconds) {
    return `这几段加起来 ${total.toFixed(1)} 秒，超过单次拼接的 ${STITCH_LIMITS.maxTotalSeconds} 秒上限。分批拼，再把成片接起来。`
  }
  return null
}
