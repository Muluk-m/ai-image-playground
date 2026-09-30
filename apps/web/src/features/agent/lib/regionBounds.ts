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
      const scanY = (y + 0.5) / height
      const crossings: number[] = []
      for (let i = 0; i < points.length; i++) {
        const a = points[i]!,
          b = points[(i + 1) % points.length]!
        if (a.y > scanY !== b.y > scanY)
          crossings.push((a.x + ((scanY - a.y) * (b.x - a.x)) / (b.y - a.y)) * width)
      }
      crossings.sort((a, b) => a - b)
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const startX = Math.max(0, Math.ceil(crossings[i]! - 0.5))
        const endX = Math.min(width, Math.ceil(crossings[i + 1]! - 0.5))
        for (let x = startX; x < endX; x++) {
          if (pixels[(y * width + x) * 4 + 3]! < 255) {
            left = Math.min(left, x)
            top = Math.min(top, y)
            right = Math.max(right, x)
            bottom = Math.max(bottom, y)
          }
        }
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
