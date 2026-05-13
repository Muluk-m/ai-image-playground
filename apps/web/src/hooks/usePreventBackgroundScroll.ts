import { useEffect, type RefObject } from 'react'

type ScrollBoundaryRef = RefObject<HTMLElement | null>

let lockCount = 0
let previousBodyOverflow = ''
let previousBodyOverscrollBehavior = ''
let previousDocumentOverscrollBehavior = ''

function getScrollBoundary(target: EventTarget | null, allowRefs?: ScrollBoundaryRef | ScrollBoundaryRef[]) {
  if (!(target instanceof Node) || !allowRefs) return null

  const refs = Array.isArray(allowRefs) ? allowRefs : [allowRefs]
  for (const ref of refs) {
    const element = ref.current
    if (element?.contains(target)) return element
  }

  return null
}

export function usePreventBackgroundScroll(active: boolean, allowRefs?: ScrollBoundaryRef | ScrollBoundaryRef[]) {
  useEffect(() => {
    if (!active) return

    if (lockCount === 0) {
      previousBodyOverflow = document.body.style.overflow
      previousBodyOverscrollBehavior = document.body.style.overscrollBehavior
      previousDocumentOverscrollBehavior = document.documentElement.style.overscrollBehavior
      document.body.style.overflow = 'hidden'
      document.body.style.overscrollBehavior = 'none'
      document.documentElement.style.overscrollBehavior = 'none'
    }
    lockCount += 1

    const preventOutside = (event: WheelEvent | TouchEvent) => {
      const boundary = getScrollBoundary(event.target, allowRefs)
      if (!boundary) event.preventDefault()
    }

    document.addEventListener('wheel', preventOutside, { capture: true, passive: false })
    document.addEventListener('touchmove', preventOutside, { capture: true, passive: false })

    return () => {
      document.removeEventListener('wheel', preventOutside, { capture: true })
      document.removeEventListener('touchmove', preventOutside, { capture: true })

      lockCount = Math.max(0, lockCount - 1)
      if (lockCount === 0) {
        document.body.style.overflow = previousBodyOverflow
        document.body.style.overscrollBehavior = previousBodyOverscrollBehavior
        document.documentElement.style.overscrollBehavior = previousDocumentOverscrollBehavior
      }
    }
  }, [active, allowRefs])
}

