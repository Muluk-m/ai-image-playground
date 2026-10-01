import type { ProductionContext } from '@image-playground/shared'
import { useSyncExternalStore } from 'react'

let pendingOpen: { conversationId: string | null; pane?: 'script' | 'storyboard' } | null = null
let active: {
  token: symbol
  conversationId: string | null
  open: (pane?: 'script' | 'storyboard') => void
} | null = null
const selected = new Map<string, ProductionContext>()
const panels = new Map<string, ProductionContext>()
const listeners = new Set<() => void>()
function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function emit() {
  for (const listener of listeners) listener()
}
export function setProductionSelection(
  conversationId: string | null,
  context: ProductionContext | null,
): void {
  if (!conversationId) return
  if (context) selected.set(conversationId, structuredClone(context))
  else selected.delete(conversationId)
  emit()
}
export function useProductionSelection(conversationId: string | null): ProductionContext | null {
  return useSyncExternalStore(
    subscribe,
    () => (conversationId ? (selected.get(conversationId) ?? null) : null),
    () => null,
  )
}
export function setProductionPanelContext(
  conversationId: string,
  context: ProductionContext | null,
): void {
  if (context) panels.set(conversationId, context)
  else panels.delete(conversationId)
}
export function activateProduction(
  conversationId: string | null,
  open: (pane?: 'script' | 'storyboard') => void,
): () => void {
  const token = Symbol('production')
  active = { token, conversationId, open }
  if (pendingOpen?.conversationId === conversationId) {
    const pending = pendingOpen
    pendingOpen = null
    open(pending.pane)
  }
  return () => {
    if (active?.token === token) active = null
  }
}
export function openProductionContent(
  conversationId: string | null,
  pane?: 'script' | 'storyboard',
): void {
  if (active?.conversationId === conversationId) active.open(pane)
  else pendingOpen = { conversationId, pane }
}
export function locateProductionSelection(
  conversationId: string,
  context?: ProductionContext,
): void {
  const target = context ?? selected.get(conversationId)
  openProductionContent(
    conversationId,
    target?.target === 'shot' || target?.target === 'shots' ? 'storyboard' : 'script',
  )
  requestAnimationFrame(() =>
    window.dispatchEvent(
      new CustomEvent('production:locate', {
        detail: { conversationId, context: context ?? selected.get(conversationId) },
      }),
    ),
  )
}
/** Read once when sending; queued/replayed turns keep their existing parameter snapshot. */
export function productionTurnContext(conversationId: string | null): {
  productionMode?: true
  production?: ProductionContext
} {
  if (active?.conversationId !== conversationId) return {}
  const context = conversationId
    ? (selected.get(conversationId) ?? panels.get(conversationId))
    : undefined
  return {
    productionMode: true,
    ...(context ? { production: structuredClone(context) } : {}),
  }
}
