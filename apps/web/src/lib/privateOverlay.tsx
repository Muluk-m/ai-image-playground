import type { ComponentType } from 'react'
import { accountRequired } from '../auth/loginPrompt'
import { privateWebOverlay } from '../features/billing'

export interface PrivateSubmissionInput {
  model: string
  /** 计价单位数：图片任务是张数，视频任务是秒数。 */
  quantity: number
  /** 单位倍率，缺省 1；视频按模型与清晰度取 videoRateMultiplier，图片取 imageRateMultiplier。 */
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
  /** Account metering mode; omitted by public/legacy overlays and treated as credits. */
  metering?: 'credits' | 'none'
  /** 本次要扣的积分；overlay 缺席或没有计价目录时 undefined，界面上就不写积分。 */
  estimatedCredits?: number
  /** 可用于本次确认的总余额；整组执行按逐任务取整后的总价检查。 */
  availableCredits?: number
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
  /** Private-only provider marks; public login renders a generic fallback when absent. */
  oauthProviderMarks?: Readonly<Record<string, ComponentType>>
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

const overlay: PrivateWebOverlay = privateWebOverlay

export const PrivateWebHeaderCreditAction = overlay.HeaderCreditAction
export const PrivateWebHeaderAccountActions = overlay.HeaderAccountActions
export const PrivateWebReplacesAuthActions = overlay.replacesAuthActions
export const PrivateWebSupportsReferrals = overlay.supportsReferrals
export const PrivateWebOAuthProviderMarks = overlay.oauthProviderMarks ?? {}
export const PrivateWebMembership = overlay.membership ?? null
/** 计费与账户面板模块已内置；具体展示仍按运行时 capabilities 控制。 */
export const PrivateWebOverlayPresent = true

/**
 * 未登录访客没有积分账户可读，overlay 只会报「读不到积分」并把生成按钮禁掉——那不是
 * 他该看到的答案，也挡住了本来要把他引去登录的那一次点击。所以这里先当成无门禁放行，
 * 提交路径上的 requireAccount() 会把登录框叫起来；登录后 reload，再按真实余额判断。
 */
const ANONYMOUS_GUARD: PrivateSubmissionGuard = Object.freeze({ blocked: false })

export function usePrivateSubmissionGuard(input: PrivateSubmissionInput): PrivateSubmissionGuard {
  // hook 不能有条件地调用：先照常问 overlay，再决定用不用它的答案。
  const guard = overlay.useSubmissionGuard(input)
  return accountRequired() ? ANONYMOUS_GUARD : guard
}

export function getPrivateSubmissionGuard(input: PrivateSubmissionInput): PrivateSubmissionGuard {
  return accountRequired() ? ANONYMOUS_GUARD : overlay.getSubmissionGuard(input)
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
