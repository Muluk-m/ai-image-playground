import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { isImageTruncated } from '../../lib/imageBytes'

const url = (bytes: Uint8Array, mime = 'image/png') =>
  `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, data, Buffer.alloc(4)]) // CRC 不参与结构判断
}

function png(): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(64, 0)
  header.writeUInt32BE(64, 4)
  header[8] = 8
  header[9] = 2
  const raw = Buffer.alloc(64 * (1 + 64 * 3))
  for (let i = 0; i < raw.length; i += 1) raw[i] = Math.imul(i, 2654435761) >>> 24
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function jpeg(trailing = 0): Buffer {
  const entropy = Buffer.alloc(5000, 0x11)
  // 熵编码段里的 FF00（填充）与 RST0 不是 marker，也不能被当成 EOI。
  entropy.set([0xff, 0x00, 0xff, 0xd0, 0xff, 0x00], 100)
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x00, 0x10]),
    Buffer.alloc(14, 0x4a),
    Buffer.from([0xff, 0xda, 0x00, 0x08]),
    Buffer.alloc(6, 0x01),
    entropy,
    Buffer.from([0xff, 0xd9]),
    Buffer.alloc(trailing, 0x22),
  ])
}

function webp(): Buffer {
  const body = Buffer.concat([
    Buffer.from('WEBP'),
    Buffer.from('VP8 '),
    Buffer.from([0xd0, 0x07, 0x00, 0x00]), // chunk 长度 2000
    Buffer.alloc(2000, 7),
  ])
  const size = Buffer.alloc(4)
  size.writeUInt32LE(body.length, 0)
  return Buffer.concat([Buffer.from('RIFF'), size, body])
}

describe('isImageTruncated', () => {
  it('accepts complete PNG, JPEG and WebP', () => {
    expect(isImageTruncated(url(png()))).toBe(false)
    expect(isImageTruncated(url(jpeg(), 'image/jpeg'))).toBe(false)
    expect(isImageTruncated(url(webp(), 'image/webp'))).toBe(false)
  })

  it('flags PNG, JPEG and WebP cut short after a valid header', () => {
    const p = png()
    expect(isImageTruncated(url(p.subarray(0, Math.floor(p.length * 0.6))))).toBe(true)
    expect(isImageTruncated(url(p.subarray(0, p.length - 12)))).toBe(true)
    expect(isImageTruncated(url(jpeg().subarray(0, 3000), 'image/jpeg'))).toBe(true)
    expect(isImageTruncated(url(jpeg().subarray(0, 105), 'image/jpeg'))).toBe(true)
    expect(isImageTruncated(url(webp().subarray(0, 1000), 'image/webp'))).toBe(true)
    // RIFF 总长被改成当前长度，但内部 chunk 声明的长度超出：仍是截断。
    const w = Buffer.from(webp().subarray(0, 1000))
    w.writeUInt32LE(w.length - 8, 4)
    expect(isImageTruncated(url(w, 'image/webp'))).toBe(true)
  })

  it('does not flag trailing data after the end marker', () => {
    expect(isImageTruncated(url(jpeg(30_000), 'image/jpeg'))).toBe(false)
    expect(isImageTruncated(url(Buffer.concat([png(), Buffer.alloc(100)])))).toBe(false)
  })

  it('handles JPEG fill bytes and malformed IEND', () => {
    const j = jpeg()
    const padded = Buffer.concat([j.subarray(0, j.length - 2), Buffer.from([0xff, 0xff, 0xd9])])
    expect(isImageTruncated(url(padded, 'image/jpeg'))).toBe(false)
    // IEND 头部在、长度却不为 0：不算收尾。
    const p = png()
    const bad = Buffer.from(p)
    bad.writeUInt32BE(1, p.length - 12)
    expect(isImageTruncated(url(bad))).toBe(true)
  })

  it('is not fooled by an IEND-looking byte run inside the data', () => {
    // IDAT 里偶然出现 IEND：截断后仍应判为截断。
    const p = png()
    const cut = Buffer.from(p.subarray(0, 200))
    cut.write('IEND', 100, 'latin1')
    expect(isImageTruncated(url(cut))).toBe(true)
  })

  it('tolerates whitespace in base64 and nonstandard JPEG layouts', () => {
    const wrapped = url(png()).replace(/(.{76})/g, '$1\n')
    expect(isImageTruncated(wrapped)).toBe(false)
    const odd = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(14, 0x4a),
      Buffer.alloc(500, 0x11), // 段后不是 marker：结构对不上，放行
    ])
    expect(isImageTruncated(url(odd, 'image/jpeg'))).toBe(false)
  })

  it('ignores what it cannot judge', () => {
    expect(isImageTruncated('data:image/gif;base64,R0lGODlhAQABAAAAACw=')).toBe(false)
    expect(isImageTruncated('data:image/png,%89PNG')).toBe(false)
    expect(isImageTruncated('data:image/png;base64,@@@@')).toBe(false)
    expect(isImageTruncated('blob:https://x/1')).toBe(false)
  })
})
