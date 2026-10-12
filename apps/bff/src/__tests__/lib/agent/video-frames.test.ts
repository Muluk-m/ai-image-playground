import { expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

process.env.LOG_LEVEL = 'silent'

const { frameTimestamps, sampleVideo, VideoUnreadable } = await import(
  '../../../lib/agent/video-frames'
)

const canSample = Boolean(Bun.which('ffmpeg') && Bun.which('ffprobe'))

it('samples one frame a second up to eight, including the start and the end', () => {
  expect(frameTimestamps(0.02)).toEqual([0])
  expect(frameTimestamps(5)).toEqual([0, 1, 2, 3, 4, 4.96])
  expect(frameTimestamps(7)).toEqual([0, 1, 2, 3, 4, 5, 6, 6.96])
  expect(frameTimestamps(15)).toEqual([0, 2.137, 4.274, 6.411, 8.549, 10.686, 12.823, 14.96])
})

it.skipIf(!canSample)('extracts distinct jpeg stills from a short clip', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aip-video-frames-test-'))
  const file = join(directory, 'clip.mp4')
  try {
    const child = Bun.spawn(
      [
        'ffmpeg',
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=160x120:rate=10:duration=2',
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'mpeg4',
        file,
      ],
      { stdout: 'ignore', stderr: 'pipe' },
    )
    const stderr = await new Response(child.stderr).text()
    expect(await child.exited, stderr).toBe(0)
    const bytes = await readFile(file)
    // 提示时长短于成片时仍按探测到的片子取样，不把提交时长当成结尾。
    const sampled = await sampleVideo(bytes, 0.4)
    expect(sampled.durationSeconds).toBeGreaterThan(1.5)
    expect(sampled.frames[0]?.timeSeconds).toBe(0)
    expect(sampled.frames.at(-1)?.timeSeconds).toBeGreaterThan(1.5)
    expect(sampled.frames.length).toBeGreaterThan(1)
    expect(Buffer.from(sampled.frames[0]!.jpeg).equals(Buffer.from(sampled.frames[1]!.jpeg))).toBe(
      false,
    )
    const size = await sharp(sampled.frames[0]!.jpeg).metadata()
    expect(size.width).toBeLessThanOrEqual(1024)
    expect(size.height).toBeLessThanOrEqual(1024)
    expect(sampled.frames[0]!.jpeg[0]).toBe(0xff)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it.skipIf(!canSample)('rejects a playlist instead of opening anything it names', async () => {
  const playlist = new TextEncoder().encode(
    'ffconcat version 1.0\nfile http://127.0.0.1:9/secret\n',
  )
  const failed = await sampleVideo(playlist).then(
    () => null,
    (error: unknown) => error,
  )
  expect(failed).toBeInstanceOf(VideoUnreadable)
  expect(String(failed)).not.toContain('secret')
  expect(String(failed)).not.toContain('127.0.0.1')
})

it.skipIf(canSample)('says the clip cannot be sampled when ffmpeg is absent', async () => {
  const failed = await sampleVideo(new Uint8Array([0, 1, 2, 3])).then(
    () => null,
    (error: unknown) => error,
  )
  expect(failed).toBeInstanceOf(VideoUnreadable)
  expect((failed as InstanceType<typeof VideoUnreadable>).userMessage).toBe(
    '这段视频暂时抽不出画面，请稍后再试。',
  )
  expect(String(failed)).not.toContain('ENOENT')
})
