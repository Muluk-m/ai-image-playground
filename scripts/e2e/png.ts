import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)
  return Buffer.concat([head, data, crc])
}

/** 纯色 PNG，颜色由 seed 的哈希决定：同一个 seed 永远得到逐字节相同的图片。 */
export function solidPng(seed: string, width = 256, height = 256): Buffer {
  const [r, g, b] = createHash('sha256').update(seed).digest()
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // 位深
  header[9] = 2 // RGB
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x += 1) row.set([r ?? 0, g ?? 0, b ?? 0], 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 带噪声的 PNG（压缩后体积随尺寸增长），同一个 seed 逐字节相同；用来做「从中间截断」的样本。 */
export function noisePng(seed: string, width = 256, height = 256): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  const stride = 1 + width * 3
  const raw = Buffer.alloc(stride * height)
  let block = createHash('sha256').update(seed).digest()
  for (let offset = 0; offset < raw.length; offset += 32) {
    block = createHash('sha256').update(block).digest()
    block.copy(raw, offset, 0, Math.min(32, raw.length - offset))
  }
  for (let y = 0; y < height; y += 1) raw[y * stride] = 0 // 每行滤波类型 None
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
