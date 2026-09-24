/**
 * 这段字节到底是什么图，按文件头判，不看谁在旁边写了什么。
 *
 * 画布上的原图是 data URL，那行 `data:image/png` 只是写上去的一句话：产出它的那条路
 * 换过编码、复制粘贴串过标签，里头装的可能是 WebP。上云时申报的类型要与字节一致，
 * 否则服务端解出来的格式对不上申报，确认那一步整张打回（422 `media_invalid_image`）。
 *
 * 只认云媒体收的这三种；认不出的交回 undefined，由调用方决定退回什么。
 */
export function imageMimeFromBytes(bytes: ArrayBuffer): string | undefined {
  const head = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 16))
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    head[1] === 0x50 &&
    head[2] === 0x4e &&
    head[3] === 0x47 &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  )
    return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    return 'image/jpeg'
  // WebP 是 RIFF 容器：`RIFF` + 4 字节长度 + `WEBP`。
  if (
    head.length >= 12 &&
    head[0] === 0x52 &&
    head[1] === 0x49 &&
    head[2] === 0x46 &&
    head[3] === 0x46 &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  )
    return 'image/webp'
  return undefined
}
