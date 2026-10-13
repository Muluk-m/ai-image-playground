import { useSyncExternalStore } from 'react'

/**
 * 站内定价弹层。登录后面板、登录框都从这里打开，不改地址，
 * 进行中的付款或登录不会被整页跳转冲掉。
 */
let open = false
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function openPricingSheet(): void {
  if (open) return
  open = true
  emit()
}

export function closePricingSheet(): void {
  if (!open) return
  open = false
  emit()
}

export function subscribePricingSheet(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePricingSheetOpen(): boolean {
  return useSyncExternalStore(
    subscribePricingSheet,
    () => open,
    () => false,
  )
}
