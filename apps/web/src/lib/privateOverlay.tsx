import type { ComponentType } from 'react'

export interface PrivateSubmissionInput {
  model: string
  quantity: number
}

export interface PrivateSubmissionGuard {
  blocked: boolean
  disabledReason?: string
}

export interface PrivateWebOverlay {
  HeaderActions: ComponentType
  SubmissionStatus: ComponentType<PrivateSubmissionInput>
  useSubmissionGuard(input: PrivateSubmissionInput): PrivateSubmissionGuard
  onSubmissionError(error: unknown): void
}

const EmptyComponent = () => null
const EMPTY_OVERLAY: PrivateWebOverlay = Object.freeze({
  HeaderActions: EmptyComponent,
  SubmissionStatus: EmptyComponent,
  useSubmissionGuard: () => ({ blocked: false }),
  onSubmissionError: () => {},
})

// biome-ignore lint/style/noRestrictedImports: This audited seam is the only public-tree import of private/.
const privateModules = import.meta.glob('../../../../private/apps/web/index.tsx', { eager: true })

function resolveOverlay(): PrivateWebOverlay {
  const modules = Object.values(privateModules)
  if (modules.length === 0) return EMPTY_OVERLAY
  if (modules.length > 1) throw new Error('Only one private Web overlay entry is allowed')

  const module = modules[0]
  if (!module || typeof module !== 'object' || !('privateWebOverlay' in module)) {
    throw new Error('private/apps/web/index.tsx must export privateWebOverlay')
  }
  const overlay = module.privateWebOverlay
  if (
    !overlay ||
    typeof overlay !== 'object' ||
    !('HeaderActions' in overlay) ||
    typeof overlay.HeaderActions !== 'function' ||
    !('SubmissionStatus' in overlay) ||
    typeof overlay.SubmissionStatus !== 'function' ||
    !('useSubmissionGuard' in overlay) ||
    typeof overlay.useSubmissionGuard !== 'function' ||
    !('onSubmissionError' in overlay) ||
    typeof overlay.onSubmissionError !== 'function'
  ) {
    throw new Error('privateWebOverlay does not implement the complete extension contract')
  }
  return overlay as PrivateWebOverlay
}

const overlay = resolveOverlay()

export const PrivateWebHeaderActions = overlay.HeaderActions
export const PrivateSubmissionStatus = overlay.SubmissionStatus

export function usePrivateSubmissionGuard(
  input: PrivateSubmissionInput,
): PrivateSubmissionGuard {
  return overlay.useSubmissionGuard(input)
}

export function notifyPrivateSubmissionError(error: unknown): void {
  overlay.onSubmissionError(error)
}
