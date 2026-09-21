import type { ComponentType } from 'react'

export interface PrivateSubmissionInput {
  model: string
  /** 计价单位数：图片任务是张数，视频任务是秒数。 */
  quantity: number
  /** 单位倍率，缺省 1；视频按模型与清晰度取 videoRateMultiplier。 */
  unitMultiplier?: number
}

export interface PrivateSubmissionBlockedAction {
  label: string
  run(): void
}

export interface PrivateSubmissionGuard {
  blocked: boolean
  disabledReason?: string
  blockedAction?: PrivateSubmissionBlockedAction
  /** 本次要扣的积分；overlay 缺席或没有计价目录时 undefined，界面上就不写积分。 */
  estimatedCredits?: number
}

export interface PrivateHeaderActionsProps {
  username: string | null
  loggingOut: boolean
  syncPending: boolean
  onOpenSettings(): void
  onLogout(): void
}

/**
 * 会员等级。公开树自己没有订阅，这四档是给 overlay 的账户面板与定价卡共用一把尺子——
 * 等级怎么排由 overlay 按套餐目录算（月度积分从小到大），这里只钉住取值与配色的契约，
 * 好让 `TierBadge` 这类展示件留在公开树里、两边不各画一套。
 */
export type PrivateMembershipTier = 'free' | 'basic' | 'plus' | 'max'

export interface PrivateMembership {
  tier: PrivateMembershipTier
  /** 当前套餐名；没有生效订阅时由 overlay 填「未订阅」一类的文案。 */
  planName: string
  balanceLabel: string
  /** 到期日；没有生效订阅就是 null。 */
  expiresLabel: string | null
  openAccount(): void
  openPricing(): void
}

export interface PrivateWebOverlay {
  HeaderCreditAction: ComponentType
  HeaderAccountActions: ComponentType<PrivateHeaderActionsProps>
  replacesAuthActions: boolean
  supportsReferrals: boolean
  useSubmissionGuard(input: PrivateSubmissionInput): PrivateSubmissionGuard
  getSubmissionGuard(input: PrivateSubmissionInput): PrivateSubmissionGuard
  onSubmissionError(error: unknown): void
  onSubmissionAccepted(): void
  onSubmissionSettled(): void
}

const EmptyComponent = () => null
const EMPTY_OVERLAY: PrivateWebOverlay = Object.freeze({
  HeaderCreditAction: EmptyComponent,
  HeaderAccountActions: EmptyComponent,
  replacesAuthActions: false,
  supportsReferrals: false,
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
    !('HeaderCreditAction' in overlay) ||
    typeof overlay.HeaderCreditAction !== 'function' ||
    !('HeaderAccountActions' in overlay) ||
    typeof overlay.HeaderAccountActions !== 'function' ||
    !('replacesAuthActions' in overlay) ||
    typeof overlay.replacesAuthActions !== 'boolean' ||
    !('supportsReferrals' in overlay) ||
    typeof overlay.supportsReferrals !== 'boolean' ||
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

export const PrivateWebHeaderCreditAction = overlay.HeaderCreditAction
export const PrivateWebHeaderAccountActions = overlay.HeaderAccountActions
export const PrivateWebReplacesAuthActions = overlay.replacesAuthActions
export const PrivateWebSupportsReferrals = overlay.supportsReferrals
/** 构建时带了收费 overlay；没有它，充值之类的信号没有人接。 */
export const PrivateWebOverlayPresent = overlay !== EMPTY_OVERLAY

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
