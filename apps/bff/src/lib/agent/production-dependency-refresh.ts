import { applyProductionMutation, ProductionError, updateProductionRecord } from './production'
import type { ProductionRefreshTarget } from './production-dependencies'

export async function refreshProductionDependencies(
  conversationId: string,
  userId: string,
  target: ProductionRefreshTarget,
  input: { operationId: string; baseRevision: number },
) {
  return updateProductionRecord(conversationId, userId, (current) => {
    const exists =
      target.kind === 'shot'
        ? current.document.content.shots?.some((shot) => shot.id === target.id)
        : current.document.content.clips?.some((clip) => clip.id === target.id)
    if (!exists && !current.receipts.some((receipt) => receipt.operationId === input.operationId))
      throw new ProductionError('production_not_found')
    return applyProductionMutation(
      current,
      { ...input, content: current.document.content },
      'user',
      conversationId,
      current.document.projectId,
      undefined,
      target,
    )
  })
}
