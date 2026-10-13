import { useEffect, useState } from 'react'

export const REFERENCE_DISPLAY_KEY = 'aip.referencesExpanded'
const CHANGE_EVENT = 'aip:references-expanded'

function readExpanded(): boolean {
  try {
    return localStorage.getItem(REFERENCE_DISPLAY_KEY) === 'true'
  } catch {
    return false
  }
}

/** A display preference shared by composers on this device, not part of a saved draft. */
export function useReferenceDisplay() {
  const [expanded, setExpanded] = useState(readExpanded)
  useEffect(() => {
    const local = (event: Event) => setExpanded((event as CustomEvent<boolean>).detail)
    const storage = (event: StorageEvent) => {
      if (event.key === REFERENCE_DISPLAY_KEY || event.key === null) setExpanded(readExpanded())
    }
    window.addEventListener(CHANGE_EVENT, local)
    window.addEventListener('storage', storage)
    return () => {
      window.removeEventListener(CHANGE_EVENT, local)
      window.removeEventListener('storage', storage)
    }
  }, [])
  const change = (next: boolean) => {
    try {
      localStorage.setItem(REFERENCE_DISPLAY_KEY, String(next))
    } catch {
      // Storage can be unavailable; the current page still supports both layouts.
    }
    setExpanded(next)
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }))
  }
  return [expanded, change] as const
}
