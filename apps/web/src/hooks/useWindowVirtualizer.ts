import {
  observeWindowOffset,
  observeWindowRect,
  type PartialKeys,
  Virtualizer,
  type VirtualizerOptions,
  windowScroll,
} from '@tanstack/virtual-core'
import { useLayoutEffect, useReducer, useState } from 'react'
import { flushSync } from 'react-dom'

type WindowVirtualizerOptions = PartialKeys<
  VirtualizerOptions<Window, HTMLElement>,
  'getScrollElement' | 'observeElementRect' | 'observeElementOffset' | 'scrollToFn'
>

/**
 * 跟着页面滚动的虚拟列表。按 `@tanstack/react-virtual` 的 React 接法直接用 virtual-core：
 * 核心不依赖 React，免得为一个适配层再引入一份按 React 版本解析的依赖。
 */
export function useWindowVirtualizer(options: WindowVirtualizerOptions) {
  const rerender = useReducer((count: number) => count + 1, 0)[1]
  const resolved: VirtualizerOptions<Window, HTMLElement> = {
    getScrollElement: () => (typeof document !== 'undefined' ? window : null),
    observeElementRect: observeWindowRect,
    observeElementOffset: observeWindowOffset,
    scrollToFn: windowScroll,
    initialOffset: () => (typeof document !== 'undefined' ? window.scrollY : 0),
    ...options,
    onChange: (instance, sync) => {
      if (sync) flushSync(rerender)
      else rerender()
      options.onChange?.(instance, sync)
    },
  }
  const [instance] = useState(() => new Virtualizer<Window, HTMLElement>(resolved))
  instance.setOptions(resolved)
  useLayoutEffect(() => instance._didMount(), [instance])
  useLayoutEffect(() => instance._willUpdate())
  return instance
}
