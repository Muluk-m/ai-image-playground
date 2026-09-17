/** 羽化向选区内部收敛；不向未选中的像素借用任何生成内容。 */
export function inwardMaskDistance(
  mask: Uint8Array,
  width: number,
  height: number,
  radius: number,
) {
  const distance = new Uint8Array(width * height)
  for (let i = 0; i < distance.length; i++) distance[i] = mask[i * 4 + 3] === 255 ? 0 : radius
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (x > 0) distance[i] = Math.min(distance[i]!, distance[i - 1]! + 1)
      if (y > 0) distance[i] = Math.min(distance[i]!, distance[i - width]! + 1)
    }
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x
      if (x < width - 1) distance[i] = Math.min(distance[i]!, distance[i + 1]! + 1)
      if (y < height - 1) distance[i] = Math.min(distance[i]!, distance[i + width]! + 1)
    }
  return distance
}
