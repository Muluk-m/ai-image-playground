import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  PanelLeft,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import * as React from 'react'

// Web 使用语义图标名，Admin 直接使用 Lucide；两种调用都识别约定图标。
const OBVIOUS_ICON_NAMES = new Set([
  'close',
  'search',
  'back',
  'chevronLeft',
  'chevronRight',
  'chevronUp',
  'chevronDown',
  'add',
  'more',
  'copy',
  'check',
  'edit',
  'delete',
  'download',
  'upload',
  'attach',
  'favorite',
  'refresh',
  'undo',
  'redo',
  'duplicate',
  'zoomIn',
  'zoomOut',
  'fullscreen',
  'minimize',
  'play',
  'pause',
  'stop',
  'send',
  'volume',
  'sidebar',
  'settings',
  'filter',
  'sort',
  'moveUp',
  'moveDown',
  'lock',
  'unlock',
])
const OBVIOUS_ICONS = new Set<React.ElementType>([
  X,
  Search,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ArrowUp,
  ArrowDown,
  Copy,
  Check,
  Trash2,
  RefreshCw,
  PanelLeft,
])

export function obviousIconOnly(node: React.ReactNode): boolean {
  let hasIcon = false
  let other = false
  const walk = (child: React.ReactNode) => {
    if (child == null || typeof child === 'boolean') return
    if (typeof child === 'string' || typeof child === 'number') {
      if (String(child).trim() !== '') other = true
      return
    }
    if (Array.isArray(child)) {
      for (const one of child) walk(one)
      return
    }
    if (!React.isValidElement(child)) return
    const props = child.props as { name?: unknown; className?: unknown; children?: React.ReactNode }
    const className = typeof props.className === 'string' ? props.className : ''
    if (className.split(/\s+/).includes('sr-only')) return
    if (typeof props.name === 'string' && props.children == null) {
      if (OBVIOUS_ICON_NAMES.has(props.name)) hasIcon = true
      else other = true
      return
    }
    if (OBVIOUS_ICONS.has(child.type as React.ElementType)) {
      hasIcon = true
      return
    }
    if (typeof child.type === 'string' || child.type === React.Fragment) {
      walk(props.children)
    } else {
      other = true
    }
  }
  walk(node)
  return hasIcon && !other
}

/** 只去掉常见图标的同名动作标签；额外说明、参数值和未知图标仍然显示。 */
export function iconActionTooltip(
  tooltip: React.ReactNode,
  props: { children?: React.ReactNode; 'aria-label'?: string; 'aria-description'?: string },
): React.ReactNode {
  return tooltip === props['aria-label'] &&
    !props['aria-description'] &&
    obviousIconOnly(props.children)
    ? undefined
    : tooltip
}
