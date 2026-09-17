import type { Camera, CanvasDoc, CanvasEl } from './canvasDoc'
import { ZOOM_MAX, ZOOM_MIN } from './canvasDoc'

type Point = { x: number; y: number }
type Contact = Point
const center = (points: Contact[]): Point => ({
  x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
  y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
})
const distance = (points: Contact[]) =>
  Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y)

export function touchCamera(camera: Camera, from: Point, to: Point, ratio = 1): Camera {
  const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, camera.zoom * ratio))
  return {
    x: camera.x + from.x / camera.zoom - to.x / zoom,
    y: camera.y + from.y / camera.zoom - to.y / zoom,
    zoom,
  }
}

/** Touch navigation owns a whole contact sequence, including the last finger after a pinch. */
export function bindCanvasTouch(
  container: HTMLElement,
  doc: CanvasDoc,
  callbacks: {
    native?: (point: Point) => boolean
    hit: (point: Point) => string | undefined
    menu: (id: string, point: Point) => void
    interrupt: () => void
    active: (value: boolean) => void
  },
) {
  let contacts: Contact[] = []
  let origin: Point = { x: 0, y: 0 }
  let initialCamera = doc.camera
  let initialDistance = 1
  let owned = false
  let nativeSequence = false
  let moved = false
  let held = false
  let target: string | undefined
  let dragged: CanvasEl[] = []
  let captured = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let frame = 0
  let pending: (() => void) | undefined
  const cancelHold = () => {
    clearTimeout(timer)
    timer = undefined
  }
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    const apply = pending
    pending = undefined
    apply?.()
  }
  const schedule = (apply: () => void) => {
    pending = apply
    if (!frame) frame = requestAnimationFrame(flush)
  }
  const points = (event: TouchEvent): Contact[] => {
    const rect = container.getBoundingClientRect()
    return Array.from(event.touches, (touch) => ({
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top,
    }))
  }
  const rebase = () => {
    flush()
    origin = center(contacts)
    initialCamera = { ...doc.camera }
    initialDistance = contacts.length > 1 ? Math.max(1, distance(contacts)) : 1
  }
  const block = (event: Event) => {
    if (event.cancelable) event.preventDefault()
    event.stopPropagation()
  }
  const start = (event: TouchEvent) => {
    flush()
    contacts = points(event)
    if (contacts.length === 1) {
      nativeSequence = Boolean(callbacks.native?.(contacts[0]!))
      owned = (doc.tool === 'select' || doc.tool === 'hand') && !nativeSequence
      moved = false
      held = false
      captured = false
      target = callbacks.hit(contacts[0]!)
      dragged =
        doc.tool === 'select' && target && doc.selection.has(target)
          ? doc.elements.filter((element) => doc.selection.has(element.id))
          : []
    } else {
      owned = true
      moved = true
      dragged = []
      cancelHold()
      callbacks.interrupt()
      callbacks.active(true)
    }
    if (!owned) return
    block(event)
    rebase()
    if (contacts.length === 1 && target && doc.tool === 'select') {
      const id = target
      const rect = container.getBoundingClientRect()
      const point = { x: origin.x + rect.left, y: origin.y + rect.top }
      timer = setTimeout(() => {
        held = true
        dragged = []
        doc.setSelection([id])
        const element = doc.getElement(id)
        if (element?.type === 'image') callbacks.menu(id, point)
        else if (element?.type === 'text') doc.setEditingText(id)
      }, 500)
    }
  }
  const move = (event: TouchEvent) => {
    if (!owned) return
    block(event)
    contacts = points(event)
    if (!contacts.length || held) return
    const current = center(contacts)
    const dx = current.x - origin.x
    const dy = current.y - origin.y
    if (!moved && Math.hypot(dx, dy) < 8) return
    moved = true
    cancelHold()
    callbacks.active(true)
    if (contacts.length === 1 && dragged.length) {
      if (!captured) {
        doc.captureHistory()
        captured = true
      }
      schedule(() =>
        doc.updateElements(
          dragged.map((element) => ({
            id: element.id,
            patch:
              element.type === 'arrow' || element.type === 'freedraw'
                ? {
                    points: element.points.map(
                      (v, i) => v + (i % 2 ? dy : dx) / initialCamera.zoom,
                    ) as [number, number, number, number],
                  }
                : {
                    x: element.x + dx / initialCamera.zoom,
                    y: element.y + dy / initialCamera.zoom,
                  },
          })),
        ),
      )
    } else {
      const next = touchCamera(
        initialCamera,
        origin,
        current,
        contacts.length > 1 ? distance(contacts) / initialDistance : 1,
      )
      schedule(() => doc.setCamera(next))
    }
  }
  const end = (event: TouchEvent) => {
    cancelHold()
    if (!owned) {
      contacts = points(event)
      return
    }
    block(event)
    flush()
    contacts = event.type === 'touchcancel' ? [] : points(event)
    if (contacts.length) {
      moved = true
      dragged = []
      rebase()
      return
    }
    if (!moved && !held && event.type !== 'touchcancel' && doc.tool === 'select')
      doc.setSelection(target ? [target] : [])
    owned = false
    dragged = []
    callbacks.active(false)
  }
  // Konva also listens to pointer and legacy touch streams; only one may edit the document.
  const pointer = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return
    const rect = container.getBoundingClientRect()
    if (event.type === 'pointerdown' && contacts.length === 0) {
      nativeSequence = Boolean(
        callbacks.native?.({ x: event.clientX - rect.left, y: event.clientY - rect.top }),
      )
    }
    if (
      owned ||
      contacts.length > 1 ||
      (event.type === 'pointerdown' && contacts.length > 0) ||
      (!nativeSequence && (doc.tool === 'select' || doc.tool === 'hand'))
    )
      event.stopPropagation()
  }
  const options = { capture: true, passive: false }
  container.addEventListener('touchstart', start, options)
  container.addEventListener('touchmove', move, options)
  container.addEventListener('touchend', end, options)
  container.addEventListener('touchcancel', end, options)
  const pointerEvents = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const
  for (const name of pointerEvents) container.addEventListener(name, pointer, true)
  return () => {
    cancelHold()
    cancelAnimationFrame(frame)
    container.removeEventListener('touchstart', start, options)
    container.removeEventListener('touchmove', move, options)
    container.removeEventListener('touchend', end, options)
    container.removeEventListener('touchcancel', end, options)
    for (const name of pointerEvents) container.removeEventListener(name, pointer, true)
  }
}
