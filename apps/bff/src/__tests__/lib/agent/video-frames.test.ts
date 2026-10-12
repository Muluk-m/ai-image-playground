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

function box(type: string, payload = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(8 + payload.byteLength)
  new DataView(bytes.buffer).setUint32(0, bytes.byteLength)
  bytes.set(Buffer.from(type), 4)
  bytes.set(payload, 8)
  return bytes
}

function largesizeBox(type: string, payload = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(16 + payload.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 1)
  bytes.set(Buffer.from(type), 4)
  view.setUint32(8, 0)
  view.setUint32(12, bytes.byteLength)
  bytes.set(payload, 16)
  return bytes
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

it.skipIf(!canSample)('extracts stills when free and skip boxes sit in front of ftyp', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aip-video-frames-preamble-'))
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
    const padded = concat([
      largesizeBox('free', new Uint8Array(4)),
      box('skip', new Uint8Array(8)),
      await readFile(file),
    ])
    const sampled = await sampleVideo(padded, 0.4)
    expect(sampled.durationSeconds).toBeGreaterThan(1.5)
    expect(sampled.frames[0]?.timeSeconds).toBe(0)
    expect(sampled.frames[0]?.jpeg[0]).toBe(0xff)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('rejects a free box whose size runs past the file', async () => {
  const bytes = new Uint8Array(16)
  new DataView(bytes.buffer).setUint32(0, 64)
  bytes.set(Buffer.from('free'), 4)
  bytes.set(Buffer.from('ftyp'), 8)
  const failed = await sampleVideo(bytes).then(
    () => null,
    (error: unknown) => error,
  )
  expect(failed).toBeInstanceOf(VideoUnreadable)
})

it('rejects ftyp that follows a box other than free or skip', async () => {
  const bytes = concat([box('mdat'), box('ftyp', Buffer.from('isom'))])
  const failed = await sampleVideo(bytes).then(
    () => null,
    (error: unknown) => error,
  )
  expect(failed).toBeInstanceOf(VideoUnreadable)
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
