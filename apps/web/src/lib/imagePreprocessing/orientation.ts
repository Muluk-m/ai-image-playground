/**
 * 读 JPEG 的 EXIF 方向（1–8）；没有 EXIF、读不出来或不是 JPEG 都按 1（正向）算。
 * 只看 APP1 里的 IFD0，不解码像素。
 */
export function jpegOrientation(bytes: ArrayBuffer): number {
  const b = new Uint8Array(bytes)
  const view = new DataView(bytes)
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1
  let p = 2
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) return 1
    const marker = b[p + 1]!
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2
      continue
    }
    // 到了图像数据或结尾，前面没有 EXIF。
    if (marker === 0xda || marker === 0xd9) return 1
    const length = view.getUint16(p + 2)
    if (length < 2 || p + 2 + length > b.length) return 1
    const start = p + 4
    if (
      marker === 0xe1 &&
      length >= 16 &&
      String.fromCharCode(...b.subarray(start, start + 6)) === 'Exif\0\0'
    ) {
      const tiff = start + 6
      const end = p + 2 + length
      const order = view.getUint16(tiff)
      if (order !== 0x4949 && order !== 0x4d4d) return 1
      const little = order === 0x4949
      if (view.getUint16(tiff + 2, little) !== 42) return 1
      const ifd = tiff + view.getUint32(tiff + 4, little)
      if (ifd + 2 > end) return 1
      const count = view.getUint16(ifd, little)
      for (let at = 0; at < count; at++) {
        const entry = ifd + 2 + at * 12
        if (entry + 12 > end) return 1
        if (view.getUint16(entry, little) !== 0x0112) continue
        const value = view.getUint16(entry + 8, little)
        return value >= 1 && value <= 8 ? value : 1
      }
      return 1
    }
    p += 2 + length
  }
  return 1
}
