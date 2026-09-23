import type { TaskErrorType, TaskProgressPhase } from '@image-playground/shared'
import { requireAccount } from '../auth/loginPrompt'
import { i18next } from '../i18n'
import { useStore } from '../store'
import type { AppSettings, TaskParams } from '../types'
import { callImageApi, resumeQueueImageApi } from './api'
import { clientProfileToApiProfile } from './apiProfiles'
import { getModelCapabilities } from './channels/profileSelectors'
import { getPublicChannels } from './channels/publicChannels'
import type { ClientProfile } from './channels/types'
import { isClientCapabilityEnabled } from './clientCapabilities'
import type { CallApiResult } from './imageApiShared'
import {
  getPrivateSubmissionGuard,
  notifyPrivateSubmissionAccepted,
  notifyPrivateSubmissionError,
  notifyPrivateSubmissionSettled,
} from './privateOverlay'
import { taskErrorTypeOf } from './taskError'

/**
 * 生成任务的生命周期：门禁 → 扇出 → 幂等键 → 受理 → 队列 → 出片 / 失败 → 结算通知。
 * 工作台与画布原本各写一份，几份已经对不上（重试跳过门禁、画布续跑不刷余额也不映射错误码）。
 * 这里是唯一一份，宿主只在 seam 上实现 `GenerationSink`：一条任务在它那边长什么样、
 * 结果怎么落，由宿主自己决定；能不能发、发几条、带什么幂等键、什么时候通知 overlay，由这里决定。
 */

/** 计价口径：按哪个模型、发多少份判门禁。图片按张数，视频按秒数 × 倍率。 */
export interface GenerationCharge {
  model: string
  quantity: number
  unitMultiplier?: number
}

/** 上游给回来的可恢复句柄。宿主要把它落进持久记录，刷新后才接得回去。 */
export type GenerationReference =
  /** BFF 队列的 request_id：有它就能跳过 submit 续 poll。 */
  | { kind: 'queue'; requestId: string }
  /** 自定义服务商的任务号：由宿主自己的恢复轮询接手。 */
  | { kind: 'custom'; taskId: string }

/** 终局失败：分类 + 按分类映射好的人话（ADR-0006：按码判，不把上游原文糊给用户）。 */
export interface GenerationFailure {
  error: unknown
  code: TaskErrorType | undefined
  text: string
}

/** 这次提交里的一份变体：一句**要发出去的**提示词配一组输入图。 */
export interface GenerationVariant<C> {
  /**
   * 真正送给上游的提示词——标注指令前缀、透明输出改写、`@图N` 还原都已经拼好。
   * 宿主记录里存的那句人话不归这里管，随 `context` 走。
   */
  prompt: string
  inputImageDataUrls: string[]
  maskDataUrl?: string
  /** module 不看、原样交回 `open` 的东西：画布的放置锚点、工作台的遮罩 id 与人话提示词。 */
  context: C
}

/** 起一批生成要知道的全部。 */
export interface GenerationSpec<C> {
  settings: AppSettings
  /** 这次用的配置档案（已定模型）：门禁按它的模型计价，扇出按它的能力决定。 */
  profile: ClientProfile
  /** 整批的数量口径；`n` 是「要几张」，拆不拆成多条由扇出规则决定。 */
  params: TaskParams
  variants: GenerationVariant<C>[]
  /** 幂等键；只在这次恰好开一条任务时复用，多条各自新铸（共用会被 BFF 去重折叠成一次生成）。 */
  clientRequestId?: string
}

/** 扇出之后的一条任务：这一条发什么、带什么幂等键，`params.n` 已经折好。 */
export interface GenerationUnit<C> {
  prompt: string
  params: TaskParams
  inputImageDataUrls: string[]
  maskDataUrl?: string
  clientRequestId: string
  context: C
}

/** 一条已经有宿主记录的任务要接着跑什么。 */
export interface GenerationResumption {
  settings: AppSettings
  prompt: string
  params: TaskParams
  /** 有它就跳过 submit 直接续 poll（不重传输入图）。 */
  requestId?: string
  /** 没有 requestId 时重提交要带的东西：BFF 按幂等键去重，不会双份消耗上游配额。 */
  inputImageDataUrls?: string[]
  maskDataUrl?: string
  clientRequestId?: string
}

/**
 * 一趟生成的终局口。结果类型是参数：画布视频那条路走的是另一套队列协议（提交视频请求 →
 * 等输出元信息 → 抽封面帧），产物不是 `CallApiResult`，但通知与错误码映射要与图片同一套。
 */
export interface GenerationOutcomeReport<H, R> {
  /** 出片。抛出即按失败收场（宿主落盘失败也是这次生成失败）。 */
  delivered(handle: H, result: R): void | Promise<void>
  failed(handle: H, failure: GenerationFailure): void
}

/** 宿主记录（工作台任务行 / 画布占位框）在生命周期各处的回写口。 */
export interface GenerationReport<H> extends GenerationOutcomeReport<H, CallApiResult> {
  /** 上游受理，交回可恢复句柄。宿主必须把它写进**持久**记录。 */
  accepted(handle: H, reference: GenerationReference): void
  /**
   * 宿主记录已落盘。module 等它落定再发请求：先有记录再有请求，中途刷新才恢复得回来。
   * 宿主记录本来就是同步的（画布占位框）就不必实现。
   */
  persisted?(handle: H): Promise<void> | void
  /** 队列阶段推进。长任务只写「生成中」会让人以为卡死了。 */
  progress(handle: H, phase: TaskProgressPhase): void
}

/** 起一批生成时还要能开记录：`open` 同步返回句柄（画布要求占位框在第一个 await 之前出现）。 */
export interface GenerationSink<H, C> extends GenerationReport<H> {
  open(unit: GenerationUnit<C>): H
}

/**
 * 能不能发：内置渠道先看账号（弹出来的登录框本身是反馈，不再叠 toast），再看计费门禁。
 * 被拦下时说明原因并把出路（充值面板等）一并给出来。
 */
export function admitGeneration(
  source: ClientProfile['source'],
  charge: GenerationCharge,
): boolean {
  // BYOK 浏览器直连上游，不需要账号；内置渠道要经 BFF 的队列，没账号发不出去。
  if (source === 'builtin-edge' && !requireAccount()) return false
  const guard = getPrivateSubmissionGuard(charge)
  if (!guard.blocked) return true
  useStore
    .getState()
    .showToast(guard.disabledReason ?? i18next.t('submit.blocked', { ns: 'store' }), 'error')
  guard.blockedAction?.run()
  return false
}

/**
 * 失败 → 可行动的人话。内容安全拒绝有自己的出路（改写提示词），其余照抄错误本身那句。
 * 宿主要按码分支（工作台详情弹窗）就读 `code`，不必再认一遍文案。
 */
export function generationFailure(err: unknown): GenerationFailure {
  const code = taskErrorTypeOf(err)
  return {
    error: err,
    code,
    text:
      code === 'content_policy'
        ? i18next.t('detail.contentPolicy', { ns: 'task' })
        : err instanceof Error
          ? err.message
          : String(err),
  }
}

/**
 * 扇出规则，全仓唯一一份：
 * - 计费内置渠道整批走一条 BFF 任务，积分预留才是原子的；
 * - 其余只有**显式声明**原生 n 的模型才把 n 交给上游；
 * - 都不是就按份拆成多条，每条 n=1。
 */
function fanOutOf(profile: ClientProfile, params: TaskParams): number {
  const billed = profile.source === 'builtin-edge' && isClientCapabilityEnabled('billing:credits')
  const nativeCount = getModelCapabilities(profile, getPublicChannels())?.has('n') === true
  return billed || nativeCount ? 1 : Math.max(1, params.n)
}

/**
 * 起一批生成：门禁没过就一条也不开（返回空数组，反馈已经给过）。过了就把每一条的宿主记录
 * **同步**开出来再逐条异步跑，所以调用方 `void` 一下即返回，占位框 / 任务行立刻出现。
 */
export function startGeneration<H, C>(spec: GenerationSpec<C>, sink: GenerationSink<H, C>): H[] {
  if (spec.variants.length === 0) return []
  const quantity = Math.max(1, spec.params.n)
  const model = clientProfileToApiProfile(spec.profile).model
  // 门禁按整批的量判，否则积分不够时会先发一半再报错。
  if (!admitGeneration(spec.profile.source, { model, quantity: quantity * spec.variants.length }))
    return []

  const fanOut = fanOutOf(spec.profile, spec.params)
  const params = fanOut === 1 ? spec.params : { ...spec.params, n: 1 }
  // 幂等键逐任务唯一：多条任务共用一个键会被 BFF 去重折叠成一次生成。
  const reusable = spec.variants.length * fanOut === 1 ? spec.clientRequestId : undefined
  const handles: H[] = []
  for (const variant of spec.variants) {
    for (let index = 0; index < fanOut; index++) {
      const unit: GenerationUnit<C> = {
        prompt: variant.prompt,
        params,
        inputImageDataUrls: variant.inputImageDataUrls,
        ...(variant.maskDataUrl ? { maskDataUrl: variant.maskDataUrl } : {}),
        clientRequestId: reusable ?? crypto.randomUUID(),
        context: variant.context,
      }
      const handle = sink.open(unit)
      handles.push(handle)
      void runUnit(spec.settings, unit, handle, sink)
    }
  }
  return handles
}

/**
 * 接着跑一条已经有宿主记录的任务：有 requestId 就跳过 submit 续 poll（不重传输入图），
 * 只有幂等键就照原样重提交，BFF 按键去重。通知与错误码映射与首次提交同一套。
 */
export function resumeGeneration<H>(
  input: GenerationResumption,
  handle: H,
  report: GenerationReport<H>,
): Promise<void> {
  if (!input.requestId) {
    return runUnit(
      input.settings,
      {
        prompt: input.prompt,
        params: input.params,
        inputImageDataUrls: input.inputImageDataUrls ?? [],
        ...(input.maskDataUrl ? { maskDataUrl: input.maskDataUrl } : {}),
        clientRequestId: input.clientRequestId ?? crypto.randomUUID(),
        context: undefined,
      },
      handle,
      report,
    )
  }
  const requestId = input.requestId
  return superviseGeneration(handle, report, () =>
    resumeQueueImageApi(
      {
        settings: input.settings,
        prompt: input.prompt,
        params: input.params,
        // 续跑不重传输入图：它们本来就没随记录持久化。
        inputImageDataUrls: [],
        onQueueStatus: (phase) => report.progress(handle, phase),
      },
      requestId,
    ),
  )
}

async function runUnit<H>(
  settings: AppSettings,
  unit: GenerationUnit<unknown>,
  handle: H,
  report: GenerationReport<H>,
): Promise<void> {
  await superviseGeneration(handle, report, async () => {
    // 落盘失败也是本次提交失败：必须走同一条标错和结算通知路径，不能留一条永久 running 的任务。
    await report.persisted?.(handle)
    return callImageApi({
      settings,
      prompt: unit.prompt,
      params: unit.params,
      inputImageDataUrls: unit.inputImageDataUrls,
      ...(unit.maskDataUrl ? { maskDataUrl: unit.maskDataUrl } : {}),
      clientRequestId: unit.clientRequestId,
      onQueueSubmitted: (requestId) => {
        report.accepted(handle, { kind: 'queue', requestId })
        notifyPrivateSubmissionAccepted()
      },
      onCustomTaskEnqueued: (task) => report.accepted(handle, { kind: 'custom', ...task }),
      onQueueStatus: (phase) => report.progress(handle, phase),
    })
  })
}

/**
 * 终局收口，全仓唯一一份：出片交给宿主，失败先通知 overlay 再把映射好的文案交给宿主，
 * 结算通知无论如何都要发（顶栏余额与提交门禁停在发起之前那一份就是个 bug）。
 * 图片走 `startGeneration` / `resumeGeneration` 自然经过这里；画布视频那条路自带队列协议，
 * 它把自己那趟请求交给这里包住，收尾语义因此与图片一致。
 */
export async function superviseGeneration<H, R>(
  handle: H,
  report: GenerationOutcomeReport<H, R>,
  call: () => Promise<R>,
): Promise<void> {
  try {
    await report.delivered(handle, await call())
  } catch (err) {
    notifyPrivateSubmissionError(err)
    report.failed(handle, generationFailure(err))
  } finally {
    // 预扣此刻已经结算（成功扣费、失败退回），顶栏余额与提交门禁跟着刷新。
    notifyPrivateSubmissionSettled()
  }
}
