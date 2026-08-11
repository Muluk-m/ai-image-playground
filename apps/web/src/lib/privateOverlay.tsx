import type { ComponentType } from 'react'

export interface PrivateSubmissionInput {
  model: string
  quantity: number
}

export interface PrivateSubmissionGuard {
  blocked: boolean
  disabledReason?: string
}

export interface PrivateHeaderActionsProps {
  username: string | null
  loggingOut: boolean
  onLogout(): void
}

export interface PrivateWebOverlay {
  HeaderActions: ComponentType<PrivateHeaderActionsProps>
  replacesAuthActions: boolean
  SubmissionStatus: ComponentType<PrivateSubmissionInput>
  useSubmissionGuard(input: PrivateSubmissionInput): PrivateSubmissionGuard
  getSubmissionGuard(input: PrivateSubmissionInput): PrivateSubmissionGuard
  onSubmissionError(error: unknown): void
  onSubmissionAccepted(): void
  onSubmissionSettled(): void
}

const EmptyComponent = () => null
const EMPTY_OVERLAY: PrivateWebOverlay = Object.freeze({
  HeaderActions: EmptyComponent,
  replacesAuthActions: false,
  SubmissionStatus: EmptyComponent,
  useSubmissionGuard: () => ({ blocked: false }),
  getSubmissionGuard: () => ({ blocked: false }),
  onSubmissionError: () => {},
  onSubmissionAccepted: () => {},
  onSubmissionSettled: () => {},
})

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
    !('replacesAuthActions' in overlay) ||
    typeof overlay.replacesAuthActions !== 'boolean' ||
    !('SubmissionStatus' in overlay) ||
    typeof overlay.SubmissionStatus !== 'function' ||
    !('useSubmissionGuard' in overlay) ||
    !('getSubmissionGuard' in overlay) ||
    typeof overlay.getSubmissionGuard !== 'function' ||
    typeof overlay.useSubmissionGuard !== 'function' ||
    !('onSubmissionAccepted' in overlay) ||
    typeof overlay.onSubmissionAccepted !== 'function' ||
    !('onSubmissionSettled' in overlay) ||
    typeof overlay.onSubmissionSettled !== 'function' ||
    !('onSubmissionError' in overlay) ||
    typeof overlay.onSubmissionError !== 'function'
  ) {
    throw new Error('privateWebOverlay does not implement the complete extension contract')
  }
  return overlay as PrivateWebOverlay
}

const overlay = resolveOverlay()

export const PrivateWebHeaderActions = overlay.HeaderActions
export const PrivateWebReplacesAuthActions = overlay.replacesAuthActions
export const PrivateSubmissionStatus = overlay.SubmissionStatus

export function usePrivateSubmissionGuard(input: PrivateSubmissionInput): PrivateSubmissionGuard {
  return overlay.useSubmissionGuard(input)
}

export function getPrivateSubmissionGuard(input: PrivateSubmissionInput): PrivateSubmissionGuard {
  return overlay.getSubmissionGuard(input)
}

export function notifyPrivateSubmissionAccepted(): void {
  overlay.onSubmissionAccepted()
}

export function notifyPrivateSubmissionError(error: unknown): void {
  overlay.onSubmissionError(error)
}

export function notifyPrivateSubmissionSettled(): void {
  overlay.onSubmissionSettled()
}
