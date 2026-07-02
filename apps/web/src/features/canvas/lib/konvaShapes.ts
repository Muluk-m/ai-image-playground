import type Konva from 'konva'
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

export function freedrawProps(el: FreedrawEl): Konva.LineConfig {
  return {
    points: [...el.points],
    stroke: el.stroke,
    strokeWidth: el.strokeWidth,
    lineCap: 'round',
    lineJoin: 'round',
    tension: 0.4,
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
