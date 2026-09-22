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
 * 右上角账号簇里那一格会员位的**渲染契约**。公开树不认识「等级」这个概念——等级、配色、
 * 徽标画法全是收费版独有的，按 `docs/dual-edition-isolation.md` 第 (i) 条它们得留在 overlay
 * 里真删掉。所以这里只留展示所需的最小面：一个徽标组件、一个强调色、一句文案、一个动作。
 */
export interface PrivateMembershipView {
  /** 有生效订阅时 false 走「开通会员」引导，true 走等级展示。 */
  subscribed: boolean
  /** 已订阅时是套餐名；未订阅时由 overlay 给引导文案。 */
  label: string
  /** 徽标与文字的强调色（overlay 传十六进制，公开树只往 style 里塞）。 */
  accent: string
  /** 徽标；由 overlay 提供，公开树不画。 */
  Badge: ComponentType<{ size?: number }>
  /** 鼠标悬停补充说明，例如到期日。 */
  hint: string | null
  /** 点这一格该干什么：已订阅去账户，未订阅去套餐页。 */
  open(): void
}

export interface PrivateMembershipSlot {
  useMembership(): PrivateMembershipView
}

export interface PrivateWebOverlay {
  HeaderCreditAction: ComponentType
  HeaderAccountActions: ComponentType<PrivateHeaderActionsProps>
  /** 会员等级与引导的数据源；缺 overlay 时右上角不渲染会员位。 */
  membership?: PrivateMembershipSlot
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
export const PrivateWebMembership = overlay.membership ?? null
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
