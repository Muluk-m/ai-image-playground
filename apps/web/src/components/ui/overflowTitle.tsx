import { type Ref, useLayoutEffect, useRef, useState } from 'react'

/** 亚像素差不算裁切，避免边框取整把完整文字误判成溢出。 */
const CLIP_SLOP = 1

export function isTextOverflowing(node: HTMLElement): boolean {
  return (
    node.scrollWidth - node.clientWidth > CLIP_SLOP ||
    node.scrollHeight - node.clientHeight > CLIP_SLOP
  )
}

function isHidden(node: HTMLElement): boolean {
  const style = getComputedStyle(node)
  return style.display === 'none' || style.visibility === 'hidden'
}

/**
 * 已经完整显示的文字不加 title。
 * `whenHidden`：这段文字被收成纯图标（display:none）时，把完整标签交给外层控件。
 */
export function useOverflowTitle<T extends HTMLElement>(
  label: string,
  options?: { whenHidden?: boolean },
) {
  const ref = useRef<T>(null)
  const [title, setTitle] = useState<string | undefined>()
  const whenHidden = options?.whenHidden ?? false
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const update = () => {
      const hidden = isHidden(node)
      const show = hidden ? whenHidden : isTextOverflowing(node)
      setTitle(show && label ? label : undefined)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(node)
    if (node.parentElement) observer.observe(node.parentElement)
    return () => observer.disconnect()
  }, [label, whenHidden])
  return { ref, title }
}

/** 截断文本：只在真正溢出时用原生 title 显示同一段完整文字。 */
export function OverflowText({
  as = 'span',
  text,
  className,
}: {
  as?: 'span' | 'p' | 'div' | 'h3'
  text: string
  className?: string
}) {
  const { ref, title } = useOverflowTitle<HTMLElement>(text)
  const nodeRef = ref as Ref<
    HTMLParagraphElement & HTMLDivElement & HTMLHeadingElement & HTMLSpanElement
  >
  if (as === 'p')
    return (
      <p ref={nodeRef} className={className} title={title}>
        {text}
      </p>
    )
  if (as === 'div')
    return (
      <div ref={nodeRef} className={className} title={title}>
        {text}
      </div>
    )
  if (as === 'h3')
    return (
      <h3 ref={nodeRef} className={className} title={title}>
        {text}
      </h3>
    )
  return (
    <span ref={nodeRef} className={className} title={title}>
      {text}
    </span>
  )
}
