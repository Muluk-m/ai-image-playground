import {
  clampGeminiNonMemberRequest,
  clampGptNonMemberRequest,
  type ImageRateRequest,
  imageRateMultiplier,
  isGptDirectModel,
  isGptNonMemberRequest,
  isGptSub2apiDeliverable,
} from './gpt-direct'
import { imageSizeTier } from './image'

/**
 * 图片生成从哪个入口提交。入口决定档位怎么收口，由调用方显式给出，不从它带了什么字段去推断：
 * - `web-direct`：网站直接提交，GPT 与 Gemini 都按会员身份收口。
 * - `cli-strict`：CLI，参数原样保留，不能兑现就在事务内拒绝，不降级。
 * - `agent` / `stage` / `batch` / `look`：智能体、阶段授权、批量、灵感套用。GPT 一律收到非会员上限，
 *   会员也一样（准备与提交用同一套收法，哈希才对得上）；Gemini 仍按真实会员身份。
 */
export type ImageTierEntry = 'web-direct' | 'cli-strict' | 'agent' | 'stage' | 'batch' | 'look'

type GptPolicy = 'by-member' | 'preserve' | 'ceiling'
type GeminiPolicy = 'by-member' | 'preserve'

const ENTRY_POLICY: Record<ImageTierEntry, { gpt: GptPolicy; gemini: GeminiPolicy }> = {
  'web-direct': { gpt: 'by-member', gemini: 'by-member' },
  'cli-strict': { gpt: 'preserve', gemini: 'preserve' },
  agent: { gpt: 'ceiling', gemini: 'by-member' },
  stage: { gpt: 'ceiling', gemini: 'by-member' },
  batch: { gpt: 'ceiling', gemini: 'by-member' },
  look: { gpt: 'ceiling', gemini: 'by-member' },
}

export interface ImageTierInput<T extends ImageRateRequest> {
  readonly model: string
  /** `gemini` 走 Gemini 的会员收口；`openai-compat` 的 4K 按 `size` 的像素折算。 */
  readonly provider: string
  readonly request: T
  readonly entry: ImageTierEntry
  /** 账号此刻是否会员，由调用方查好传入；本函数不查库。 */
  readonly member: boolean
  /** GPT 直连是否能兑现高档参数。直连不可用时，会员的 GPT 也收到非会员上限。 */
  readonly directAvailable: boolean
  /** 渠道声明的可出档；没声明就按请求档计价。 */
  readonly supportedTiers?: readonly string[]
}

export interface ImageTierRequires {
  /** 这次请求落在要订阅的档位上，提交前必须过会员门。 */
  readonly membership: boolean
  /** 只有 OpenAI 直连兑现得了，直连没开就拒绝。只有 CLI 严格入口会出现。 */
  readonly directRoute: boolean
}

export interface ImageTierDecision<T extends ImageRateRequest> {
  readonly effectiveRequest: T
  /** 按 effectiveRequest 与 supportedTiers 的积分倍率，提案、提交、结算共用。 */
  readonly rateMultiplier: number
  readonly requires: ImageTierRequires
}

/** 落库到 `tasks.metering.tier` 的快照；旧任务行没有它。 */
export interface ImageTierSnapshot {
  readonly entry: ImageTierEntry
  /**
   * 决策用到的会员位。只有会员与否会改变结果时才查询；没查询就是 false，
   * 不代表账号不是会员，不要拿它做对账、退差价或运营统计。
   */
  readonly memberApplied: boolean
  readonly requires: ImageTierRequires
}

function fourKRequested(provider: string, request: ImageRateRequest): boolean {
  if (request.image_size === '4K') return true
  return provider === 'openai-compat' && !!request.size && imageSizeTier(request.size) === '4K'
}

function alignGpt<T extends ImageRateRequest>(input: ImageTierInput<T>, policy: GptPolicy): T {
  if (!isGptDirectModel(input.model) || policy === 'preserve') return input.request
  if (policy === 'by-member') {
    if (isGptNonMemberRequest(input.request)) return input.request
    if (input.member && input.directAvailable) return input.request
  }
  return clampGptNonMemberRequest(input.model, input.request)
}

function requiresOf(
  input: ImageTierInput<ImageRateRequest>,
  effective: ImageRateRequest,
): ImageTierRequires {
  if (
    input.entry === 'cli-strict' &&
    isGptDirectModel(input.model) &&
    !isGptSub2apiDeliverable(effective)
  )
    return { membership: !isGptNonMemberRequest(effective), directRoute: true }
  return { membership: fourKRequested(input.provider, effective), directRoute: false }
}

/**
 * 图片档位策略的唯一入口：给定入口、模型和会员身份，算出实际生效的请求、积分倍率和提交前的要求。
 * 纯函数，不查库；是否放行（私有 overlay 的会员门、直连是否配置）由调用方按 `requires` 判定。
 * 重复解析结果不变，准备与提交两次算出的请求、哈希一致。
 */
export function resolveImageTier<T extends ImageRateRequest>(
  input: ImageTierInput<T>,
): ImageTierDecision<T> {
  const policy = ENTRY_POLICY[input.entry]
  const gptAligned = alignGpt(input, policy.gpt)
  const effectiveRequest =
    input.provider === 'gemini' && policy.gemini === 'by-member'
      ? clampGeminiNonMemberRequest(gptAligned, input.member)
      : gptAligned
  return {
    effectiveRequest,
    rateMultiplier: imageRateMultiplier(input.model, effectiveRequest, input.supportedTiers),
    requires: requiresOf(input, effectiveRequest),
  }
}
