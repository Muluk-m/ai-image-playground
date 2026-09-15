import type { CanvasEl } from './canvasDoc'
import { elementBounds, STATUS_ACCENT } from './editor'
import { Box } from './geometry'

/** 小地图尺寸（CSS 像素）。右下角常驻，够看清分布又不压住画布。 */
export const MINIMAP_WIDTH = 160
export const MINIMAP_HEIGHT = 110
/** 内容盒四周留白：贴边的元素不至于和边框糊在一起。 */
export const MINIMAP_PADDING = 8

/**
 * 小地图里的一个元素块。画法只有两种：实心（有内容的元素）与虚框（占位框，
 * 还没出图）。颜色由元素类型决定，占位框复用 `STATUS_ACCENT` 这一份状态色单源。
 */
export interface MinimapRect {
  x: number
  y: number
  w: number
  h: number
  style: 'fill' | 'dash'
  color: string
}

/** 元素 → 小地图画法。图片 / 视频 / 文字 / 标注 / 占位框各一种，肉眼可分。 */
function rectStyle(el: CanvasEl): { style: 'fill' | 'dash'; color: string } {
  switch (el.type) {
    case 'image':
      return el.video
        ? { style: 'fill', color: 'rgba(96,165,250,0.85)' }
        : { style: 'fill', color: 'rgba(226,232,240,0.72)' }
    case 'text':
      return { style: 'fill', color: 'rgba(251,191,36,0.85)' }
    case 'freedraw':
    case 'arrow':
      // 标注用它自己的笔色：小地图上一眼对得上画布
      return { style: 'fill', color: el.stroke }
    case 'placeholder':
      return { style: 'dash', color: STATUS_ACCENT[el.status] }
  }
}

/** 一批元素 → 页面坐标下的小地图块。元素数组变了才需要重算（见 CanvasMinimap 的缓存）。 */
export function minimapRects(elements: readonly CanvasEl[]): MinimapRect[] {
  return elements.map((el) => {
    const box = elementBounds(el)
    return { x: box.x, y: box.y, w: box.w, h: box.h, ...rectStyle(el) }
  })
}

/** 一批小地图块的公共包围盒；空集返回 null。 */
export function rectsBounds(rects: readonly MinimapRect[]): Box | null {
  if (rects.length === 0) return null
  return Box.Common(rects.map((r) => new Box(r.x, r.y, r.w, r.h)))
}

/**
 * 视口框在小地图里最多占的比例：装下的范围至少是视口的 3 倍宽、3 倍高。
 * 视口把内容整个装进来时（常态），不撑开的话视口框会铺满整张小地图，
 * 看不出自己在哪、也没有可以点过去的空白，小地图就失去意义了。
 */
export const MINIMAP_VIEWPORT_RATIO = 3

/**
 * 小地图要装下的页面范围 = (元素公共包围盒 ∪ 当前视口)，再撑到至少视口的
 * `MINIMAP_VIEWPORT_RATIO` 倍。并上视口是为了用户把镜头拖到内容之外时，
 * 视口框不会滑出小地图——滑出去就点不回来了；撑开围绕并集中心对称进行，
 * 所以并集里的内容与视口都仍在范围内。内容远大于视口时范围就是内容包围盒。
 */
export function minimapSourceBox(content: Box | null, viewport: Box): Box {
  const union = content ? Box.Common([content, viewport]) : viewport
  const w = Math.max(union.w, viewport.w * MINIMAP_VIEWPORT_RATIO)
  const h = Math.max(union.h, viewport.h * MINIMAP_VIEWPORT_RATIO)
  return new Box(union.x - (w - union.w) / 2, union.y - (h - union.h) / 2, w, h)
}

/** 页面坐标 → 小地图坐标的仿射变换：`mx = x * scale + tx`。 */
export interface MinimapProjection {
  scale: number
  tx: number
  ty: number
}

/** 等比缩放并居中：保持宽高比，两个方向取较小的那个比例。 */
export function computeMinimapProjection(
  source: Box,
  size: { width: number; height: number } = { width: MINIMAP_WIDTH, height: MINIMAP_HEIGHT },
  padding: number = MINIMAP_PADDING,
): MinimapProjection {
  const innerW = Math.max(1, size.width - padding * 2)
  const innerH = Math.max(1, size.height - padding * 2)
  // 单个零尺寸元素（空文字等）会让包围盒退化成点，钳到 1 页面单位免得 scale 爆掉
  const srcW = Math.max(source.w, 1)
  const srcH = Math.max(source.h, 1)
  const scale = Math.min(innerW / srcW, innerH / srcH)
  return {
    scale,
    tx: padding + (innerW - srcW * scale) / 2 - source.x * scale,
    ty: padding + (innerH - srcH * scale) / 2 - source.y * scale,
  }
}

/** 页面坐标矩形 → 小地图坐标矩形。 */
export function projectBox(
  proj: MinimapProjection,
  box: { x: number; y: number; w: number; h: number },
): { x: number; y: number; w: number; h: number } {
  return {
    x: box.x * proj.scale + proj.tx,
    y: box.y * proj.scale + proj.ty,
    w: box.w * proj.scale,
    h: box.h * proj.scale,
  }
}

/** 小地图坐标 → 页面坐标（点击 / 拖动定位用）。 */
export function minimapPointToPage(
  proj: MinimapProjection,
  mx: number,
  my: number,
): { x: number; y: number } {
  return { x: (mx - proj.tx) / proj.scale, y: (my - proj.ty) / proj.scale }
}

/** 让视口中心落在某个页面点上的 camera（缩放不动，参考 scrollToElements 的算法）。 */
export function cameraForCenter(
  center: { x: number; y: number },
  viewport: { width: number; height: number },
  zoom: number,
): { x: number; y: number } {
  return {
    x: center.x - viewport.width / zoom / 2,
    y: center.y - viewport.height / zoom / 2,
  }
}

/** 页面点是否落在视口框内：决定按下去是「拖视口」还是「跳到这里」。 */
export function isInsideBox(box: Box, point: { x: number; y: number }): boolean {
  return point.x >= box.x && point.x <= box.maxX && point.y >= box.y && point.y <= box.maxY
}
