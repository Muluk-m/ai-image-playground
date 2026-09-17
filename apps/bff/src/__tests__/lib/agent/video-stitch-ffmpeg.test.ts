import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseStitchProbe,
  type StitchProbe,
  stitchFfmpegArgs,
  stitchProbeArgs,
  stitchTarget,
} from '../../../lib/agent/video-stitch-plan'
import { detectFfmpeg, ffmpegRunner, setFfmpegForTesting } from '../../../lib/ffmpeg'

process.env.LOG_LEVEL = 'silent'

/**
 * 唯一一条真的调 ffmpeg 的测试：**本机没装就整条跳过**，别的用例一律走可注入的执行接缝。
 * 它守的是那些只有真二进制才会说出口的事——滤镜图的写法、concat 对输入流数的要求、
 * 补静音那一路到底接不接得上。
 */
const available = await detectFfmpeg()
// 探测会把全局标志翻成「可用」，跑完复位，免得漏给同一进程里的别人。
setFfmpegForTesting()

const TIMEOUT = { timeoutMs: 120_000 }

let workspace = ''

beforeAll(async () => {
  if (available) workspace = await mkdtemp(join(tmpdir(), 'aip-stitch-real-'))
})

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

/** 造一段真视频：`testsrc` 出画面，`sine` 出声音，两者都能被 ffprobe 正常读出来。 */
async function makeSegment(input: {
  readonly name: string
  readonly size: string
  readonly seconds: number
  readonly withAudio: boolean
}): Promise<string> {
  const path = join(workspace, input.name)
  const result = await ffmpegRunner().ffmpeg(
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=${input.size}:rate=25:duration=${input.seconds}`,
      ...(input.withAudio ? ['-f', 'lavfi', '-i', `sine=duration=${input.seconds}`] : []),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      ...(input.withAudio ? ['-c:a', 'aac'] : []),
      '-t',
      String(input.seconds),
      path,
    ],
    TIMEOUT,
  )
  if (result.code !== 0) throw new Error(`fixture segment failed: ${result.stderr}`)
  return path
}

async function probe(path: string): Promise<StitchProbe> {
  const result = await ffmpegRunner().ffprobe(stitchProbeArgs(path), TIMEOUT)
  const parsed = parseStitchProbe(result.stdout)
  if (!parsed) throw new Error(`could not probe ${path}: ${result.stderr}`)
  return parsed
}

describe.skipIf(!available)('the arguments we build against the real ffmpeg', () => {
  it('joins a landscape silent clip and a portrait clip with sound into one playable film', async () => {
    const paths = [
      await makeSegment({ name: 'a.mp4', size: '320x180', seconds: 1, withAudio: false }),
      await makeSegment({ name: 'b.mp4', size: '180x320', seconds: 1, withAudio: true }),
    ]
    const probes = await Promise.all(paths.map(probe))
    const target = stitchTarget(probes)
    const outputPath = join(workspace, 'out.mp4')

    const run = await ffmpegRunner().ffmpeg(
      stitchFfmpegArgs({ inputPaths: paths, probes, target, outputPath }),
      TIMEOUT,
    )
    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)

    const film = await probe(outputPath)
    // 画幅取第一段，竖屏那一段被补了边；时长是两段之和。
    expect(film.width).toBe(320)
    expect(film.height).toBe(180)
    expect(film.durationSeconds).toBeGreaterThan(1.8)
    expect(film.durationSeconds).toBeLessThan(2.4)
    // 有一段有声音，成片就有一条贯穿全片的音轨——另一段补的是静音，不是没有。
    expect(film.hasAudio).toBe(true)
  }, 180_000)

  it('leaves an all-silent set of clips without an audio track', async () => {
    const paths = [
      await makeSegment({ name: 'c.mp4', size: '320x180', seconds: 1, withAudio: false }),
      await makeSegment({ name: 'd.mp4', size: '320x180', seconds: 1, withAudio: false }),
    ]
    const probes = await Promise.all(paths.map(probe))
    const outputPath = join(workspace, 'silent.mp4')
    const run = await ffmpegRunner().ffmpeg(
      stitchFfmpegArgs({ inputPaths: paths, probes, target: stitchTarget(probes), outputPath }),
      TIMEOUT,
    )
    expect(run.code).toBe(0)
    expect((await probe(outputPath)).hasAudio).toBe(false)
  }, 180_000)
})
