export interface Point {
  x: number
  y: number
}

export interface LongPress {
  start: (point: Point) => void
  move: (point: Point) => void
  cancel: () => void
}

/** 触摸长按识别：按住不动够久就触发；移动超出容差算拖拽，长按作废。 */
export function createLongPress(
  onLongPress: (point: Point) => void,
  { delayMs = 500, moveTolerancePx = 6 }: { delayMs?: number; moveTolerancePx?: number } = {},
): LongPress {
  let timer: ReturnType<typeof setTimeout> | null = null
  let origin: Point | null = null

  const cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    origin = null
  }

  return {
    start: (point) => {
      cancel()
      origin = point
      timer = setTimeout(() => {
        timer = null
        origin = null
        onLongPress(point)
      }, delayMs)
    },
    move: (point) => {
      if (!origin) return
      const movedTooFar =
        Math.abs(point.x - origin.x) > moveTolerancePx ||
        Math.abs(point.y - origin.y) > moveTolerancePx
      if (movedTooFar) cancel()
    },
    cancel,
  }
}
