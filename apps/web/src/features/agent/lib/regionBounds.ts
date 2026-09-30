export interface RegionShape {
  readonly id: number
  readonly points: readonly { x: number; y: number }[]
}
export interface VisibleRegion {
  readonly id: number
  readonly bounds: { x: number; y: number; width: number; height: number }
}

/** Intersect each polygon with the final editable pixels; scanline spans exclude its hollow corners. */
export function visibleRegionBounds(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  shapes: readonly RegionShape[],
): VisibleRegion[] {
  return shapes.flatMap(({ id, points }) => {
    let left = width,
      top = height,
      right = -1,
      bottom = -1
    const startY = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y)) * height))
    const endY = Math.min(height, Math.ceil(Math.max(...points.map((p) => p.y)) * height))
    for (let y = startY; y < endY; y++) {
      // Project coverage across the pixel row, including antialiased slivers whose
      // interior never contains a pixel center. Merge spans before scanning alpha.
      const low = y / height,
        high = (y + 1) / height
      const epsilon = 1e-10
      const levels = [low + epsilon, high - epsilon, (low + high) / 2]
      for (const point of points)
        if (point.y > low && point.y < high) levels.push(point.y - epsilon, point.y + epsilon)
      const spans: [number, number][] = []
      for (const scanY of levels) {
        const crossings: { x: number; winding: number }[] = []
        for (let i = 0; i < points.length; i++) {
          const a = points[i]!,
            b = points[(i + 1) % points.length]!
          if (a.y > scanY !== b.y > scanY)
            crossings.push({
              x: (a.x + ((scanY - a.y) * (b.x - a.x)) / (b.y - a.y)) * width,
              winding: a.y < b.y ? 1 : -1,
            })
        }
        crossings.sort((a, b) => a.x - b.x)
        let winding = 0,
          start = 0
        for (const crossing of crossings) {
          const before = winding
          winding += crossing.winding
          if (before === 0 && winding !== 0) start = crossing.x
          else if (before !== 0 && winding === 0)
            spans.push([Math.max(0, Math.floor(start)), Math.min(width, Math.ceil(crossing.x))])
        }
      }
      spans.sort((a, b) => a[0] - b[0])
      let scanned = -1
      for (const [start, end] of spans) {
        for (let x = Math.max(start, scanned); x < end; x++) {
          if (pixels[(y * width + x) * 4 + 3]! < 255) {
            left = Math.min(left, x)
            top = Math.min(top, y)
            right = Math.max(right, x)
            bottom = Math.max(bottom, y)
          }
        }
        scanned = Math.max(scanned, end)
      }
    }
    return right < 0
      ? []
      : [
          {
            id,
            bounds: {
              x: left / width,
              y: top / height,
              width: (right - left + 1) / width,
              height: (bottom - top + 1) / height,
            },
          },
        ]
  })
}

export interface RegionBoundsRequest {
  readonly version: number
  readonly pixels: Uint8ClampedArray
  readonly width: number
  readonly height: number
  readonly shapes: readonly RegionShape[]
}
