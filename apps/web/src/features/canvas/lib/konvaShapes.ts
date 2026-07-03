import Konva from 'konva'
import { getStroke } from 'perfect-freehand'
import type { ArrowEl, FreedrawEl, ImageEl, PlaceholderEl, TextEl } from './canvasDoc'
import { STATUS_ACCENT } from './editor'

/**
 * 元素 → Konva 节点属性的单源映射：
 * 实时渲染（react-konva JSX）与离屏导出（imperative Konva 节点）共用，
 * 保证「画布上看到的」与「导出给模型的」像素一致。
 */

/** 画布文字与文字编辑浮层共用的字体栈（两边不一致会跳字）。 */
export const CANVAS_FONT_FAMILY =
  "'HarmonyOS Sans SC', system-ui, -apple-system, 'Segoe UI', sans-serif"

/** 文字包围盒测量（提交 / 改字号时同步 width/height，选区与导出依赖）。 */
export function measureText(text: string, fontSize: number): { width: number; height: number } {
  const node = new Konva.Text({
    text: text || ' ',
    fontSize,
    fontFamily: CANVAS_FONT_FAMILY,
    lineHeight: 1.3,
  })
  return { width: node.width(), height: node.height() }
}

/**
 * 笔迹轮廓缓存：元素 copy-on-write，对象引用即缓存键；
 * 拖拽中每次加点都会生成新对象，自然失效重算。
 */
const strokeOutlineCache = new WeakMap<FreedrawEl, number[]>()

function freedrawOutline(el: FreedrawEl): number[] {
  const hit = strokeOutlineCache.get(el)
  if (hit) return hit
  const pts: Array<[number, number]> = []
  for (let i = 0; i < el.points.length; i += 2) pts.push([el.points[i], el.points[i + 1]])
  // perfect-freehand（tldraw 同款笔迹算法，MIT）：压感粗细 + 笔锋收尾 + 平滑
  const outline = getStroke(pts, {
    size: el.strokeWidth * 1.8,
    thinning: 0.55,
    smoothing: 0.5,
    streamline: 0.45,
    simulatePressure: true,
  }).flat()
  strokeOutlineCache.set(el, outline)
  return outline
}

export function freedrawProps(el: FreedrawEl): Konva.LineConfig {
  return {
    points: freedrawOutline(el),
    fill: el.stroke,
    closed: true,
    // 轮廓多边形自带宽度，不再描边；tension 会扭曲轮廓，禁用
    strokeEnabled: false,
    lineJoin: 'round',
  }
}

export function arrowProps(el: ArrowEl): Konva.ArrowConfig {
  return {
    points: [...el.points],
    stroke: el.stroke,
    fill: el.stroke,
    strokeWidth: el.strokeWidth,
    lineCap: 'round',
    pointerLength: 12,
    pointerWidth: 10,
  }
}

export function textProps(el: TextEl): Konva.TextConfig {
  return {
    x: el.x,
    y: el.y,
    text: el.text,
    fontSize: el.fontSize,
    fontFamily: CANVAS_FONT_FAMILY,
    fill: el.fill,
    lineHeight: 1.3,
  }
}

export function imageProps(el: ImageEl): Omit<Konva.ImageConfig, 'image'> {
  return {
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    rotation: el.rotation,
  }
}

export function placeholderProps(el: PlaceholderEl): Konva.RectConfig {
  return {
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    stroke: STATUS_ACCENT[el.status],
    strokeWidth: 2,
    dash: [8, 6],
    cornerRadius: 12,
  }
}
