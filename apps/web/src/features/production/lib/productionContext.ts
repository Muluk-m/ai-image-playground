let active: { token: symbol; conversationId: string | null; open: () => void } | null = null

export function activateProduction(conversationId: string | null, open: () => void): () => void {
  const token = Symbol('production')
  active = { token, conversationId, open }
  return () => {
    if (active?.token === token) active = null
  }
}

export function openProductionContent(conversationId: string | null): void {
  if (active?.conversationId === conversationId) active.open()
}

/** Read once when sending; queued/replayed turns keep their existing parameter snapshot. */
export function productionTurnContext(conversationId: string | null): {
  productionMode?: true
} {
  return active?.conversationId === conversationId ? { productionMode: true } : {}
}
