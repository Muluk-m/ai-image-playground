import { useEffect, useSyncExternalStore } from 'react'

const query = '(max-width: 767px)'
const subscribe = (notify: () => void) => {
  if (!window.matchMedia) return () => {}
  const media = window.matchMedia(query)
  media.addEventListener('change', notify)
  return () => media.removeEventListener('change', notify)
}

export function useMobileWorkspace() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.(query).matches ?? false,
    () => false,
  )
}

/** Keep fixed workspace controls above the software keyboard and Safari chrome. */
export function useWorkspaceViewport() {
  useEffect(() => {
    const viewport = window.visualViewport
    const root = document.documentElement
    const update = () => {
      root.style.setProperty(
        '--workspace-viewport-height',
        `${viewport?.height ?? window.innerHeight}px`,
      )
      root.style.setProperty('--workspace-viewport-top', `${viewport?.offsetTop ?? 0}px`)
      root.dataset.workspaceKeyboard = String(
        window.innerHeight - (viewport?.height ?? window.innerHeight) > 140 &&
          (document.activeElement?.matches('input, textarea, [contenteditable="true"]') ?? false),
      )
    }
    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', update)
      root.style.removeProperty('--workspace-viewport-height')
      root.style.removeProperty('--workspace-viewport-top')
      delete root.dataset.workspaceKeyboard
    }
  }, [])
}
