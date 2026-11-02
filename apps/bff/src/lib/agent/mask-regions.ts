/**
 * 连通域：蒙版清理（填洞、去碎块）与生成后的逐区域核对都按它分组。
 * `mask[i]` 非零（`inside = true`）或为零（`inside = false`）的像素归组；`diagonal` 决定
 * 8 邻接还是 4 邻接。两遍扫描加并查集，百万像素级也只要几毫秒到十几毫秒。
 */
export interface MaskComponents {
  /** 每个像素的组号，0 表示不在任何组里；组号从 1 开始。 */
  readonly labels: Int32Array
  /** 下标即组号，`areas[0]` 恒为 0。 */
  readonly areas: readonly number[]
  /** 这一组有没有碰到图片边缘。 */
  readonly touchesBorder: readonly boolean[]
}

export function labelComponents(
  mask: ArrayLike<number>,
  inside: boolean,
  width: number,
  height: number,
  diagonal: boolean,
): MaskComponents {
  const total = width * height
  const labels = new Int32Array(total)
  // 第一遍最多给出约一半像素数的临时组号（棋盘格的最坏情况）。
  const parent = new Int32Array((total >> 1) + 2)
  let count = 0
  const find = (label: number) => {
    let root = label
    while (parent[root] !== root) root = parent[root]!
    while (parent[label] !== root) {
      const up = parent[label]!
      parent[label] = root
      label = up
    }
    return root
  }
  const join = (label: number, other: number) => {
    if (!other) return label
    if (!label) return other
    if (other !== label) {
      const a = find(label)
      const b = find(other)
      if (a !== b) parent[a > b ? a : b] = a > b ? b : a
    }
    return label
  }
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      const index = row + x
      if ((mask[index] !== 0) !== inside) continue
      let label = x > 0 ? labels[index - 1]! : 0
      if (y > 0) {
        label = join(label, labels[index - width]!)
        if (diagonal) {
          if (x > 0) label = join(label, labels[index - width - 1]!)
          if (x < width - 1) label = join(label, labels[index - width + 1]!)
        }
      }
      if (!label) {
        label = ++count
        parent[label] = label
      }
      labels[index] = label
    }
  }
  const compact = new Int32Array(count + 1)
  const areas = [0]
  const touchesBorder = [false]
  for (let y = 0; y < height; y++) {
    const edgeRow = y === 0 || y === height - 1
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      const raw = labels[index]!
      if (!raw) continue
      const root = find(raw)
      let label = compact[root]!
      if (!label) {
        label = compact[root] = areas.length
        areas.push(0)
        touchesBorder.push(false)
      }
      labels[index] = label
      areas[label]!++
      if (edgeRow || x === 0 || x === width - 1) touchesBorder[label] = true
    }
  }
  return { labels, areas, touchesBorder }
}
