const DROPDOWN_GAP_PX = 8
const OVERFLOW_BOUNDARY_RE = /(auto|scroll|hidden|clip)/

export const DEFAULT_DROPDOWN_MAX_HEIGHT = 240

/**
 * 目标是否落在 portal 出去的浮层里（Radix 的下拉、弹出层都挂在 body 上）。
 *
 * 宿主菜单的「点外面就关」必须放行这一层：下拉内容不在宿主菜单的 DOM 里，不放行的话
 * pointerdown 会先把菜单连同下拉一起卸载，紧随其后的 pointerup 落在已脱离文档的选项上，
 * 选择根本不会提交。
 */
export function isInFloatingLayer(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-radix-popper-content-wrapper]') !== null
}

export function getDropdownMaxHeight(
  trigger: HTMLElement,
  maxHeight = DEFAULT_DROPDOWN_MAX_HEIGHT,
) {
  const rect = trigger.getBoundingClientRect()
  let availableHeight = window.innerHeight - rect.bottom - DROPDOWN_GAP_PX
  let parent = trigger.parentElement

  while (parent && parent !== document.body) {
    const style = window.getComputedStyle(parent)
    if (OVERFLOW_BOUNDARY_RE.test(`${style.overflow} ${style.overflowY}`)) {
      const parentRect = parent.getBoundingClientRect()
      availableHeight = Math.min(availableHeight, parentRect.bottom - rect.bottom - DROPDOWN_GAP_PX)
    }
    parent = parent.parentElement
  }

  return Math.max(0, Math.min(maxHeight, Math.floor(availableHeight)))
}
