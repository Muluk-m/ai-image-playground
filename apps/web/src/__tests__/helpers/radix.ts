import { act } from 'react'

/**
 * jsdom 缺三样 Radix 要用的东西：pointer capture、ResizeObserver，和 DOMRect。
 * 补上之后它的浮层才会打开。改的是 Element.prototype，靠 Vitest 的文件级隔离收场。
 */
export function stubPointerApis(): void {
  const proto = Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture = () => false
  proto.setPointerCapture = () => {}
  proto.releasePointerCapture = () => {}
  proto.scrollIntoView = () => {}
  const globals = globalThis as unknown as Record<string, unknown>
  globals.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globals.DOMRect ??= class {
    constructor(
      readonly x = 0,
      readonly y = 0,
      readonly width = 0,
      readonly height = 0,
    ) {}
  }
}

/**
 * Radix 只认 pointerType 是 mouse 的指针事件，而 jsdom 既没有 PointerEvent，也不会给
 * MouseEvent 补这个属性——少了它，trigger 收到 pointerdown 也不会展开。
 */
export function pointer(type: string): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, button: 0 })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  return event
}

/** 像用鼠标那样打开一个 Radix 下拉并选中一项。选项在 portal 里，所以从 document 找。 */
export function chooseOption(triggerLabel: string, optionText: string): void {
  const trigger = document.querySelector<HTMLElement>(`[aria-label="${triggerLabel}"]`)
  if (!trigger) throw new Error(`no trigger ${triggerLabel}`)
  act(() => {
    trigger.dispatchEvent(pointer('pointerdown'))
  })
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (node) => node.textContent?.trim() === optionText,
  )
  if (!option) throw new Error(`no option ${optionText}`)
  act(() => {
    option.dispatchEvent(pointer('pointermove'))
    option.dispatchEvent(pointer('pointerup'))
  })
}

/** 下拉当前显示的值。 */
export function triggerText(label: string): string {
  return document.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.textContent?.trim() ?? ''
}
