import { clientProfileToApiProfile, getActiveApiProfile } from './apiProfiles'
import { createMaskPreviewDataUrl } from './canvasImage'
import { getModelCapabilities } from './channels/profileSelectors'
import { getPublicChannel, getPublicChannels } from './channels/publicChannels'
import { callQueueChannelApi, resumeQueueChannelApi, toQueueProvider } from './channels/queueClient'
import type { ClientProfile, UserByokProfile } from './channels/types'
import { isByokGenerationEnabled } from './clientCapabilities'
import { compressInputImageDataUrls } from './compressInputImage'
import { callGeminiImageApi } from './geminiImageApi'
import {
  applyPromptRewriteGuard,
  type BYOKAdapterProfile,
  type CallApiOptions,
  type CallApiResult,
} from './imageApiShared'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import { getParamCapabilities, normalizeParamsForSettings } from './paramCompatibility'
import { buildAspectInstruction } from './size'

export { normalizeBaseUrl } from './devProxy'
export type { CallApiOptions, CallApiResult } from './imageApiShared'

function toByokAdapterProfile(profile: UserByokProfile): BYOKAdapterProfile {
  return {
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.selectedModelId,
    apiMode: profile.preferences.apiMode,
    timeout: profile.preferences.timeout,
    codexCli: profile.preferences.codexCli,
    apiProxy: profile.preferences.apiProxy,
    responseFormatB64Json: profile.preferences.responseFormatB64Json,
  }
}

/**
 * 模型是否“原生”支持遮罩（走 OpenAI images/edits 的真·inpainting）。
 * - builtin-edge：按 channel 模型 capability 'mask'（当前仅 gpt-image-2 声明）
 * - user-byok：仅 gemini kind 无原生 mask（geminiImageApi 不接受 mask）；
 *   openai-compat / http-template 走 images/edits 原生支持
 * 不支持的模型走软遮罩降级（见 applySoftMaskFallback）。
 */
function modelSupportsNativeMask(profile: ClientProfile): boolean {
  // builtin-edge：capability 声明是权威；BYOK：仅 gemini kind 不接受原生 mask
  if (profile.source === 'builtin-edge') {
    return getModelCapabilities(profile, getPublicChannels())?.has('mask') ?? false
  }
  return profile.kind !== 'gemini'
}

const SOFT_MASK_INSTRUCTION =
  'The second input image is a copy of the first image with a blue translucent overlay marking the region to edit. ' +
  'Apply the requested change ONLY inside the marked region, and keep everything outside it identical to the first (original) image. ' +
  'Do not render the blue overlay itself in the output. Instruction:'

/**
 * 软遮罩降级：模型不支持原生 mask 时，把遮罩转成「原图 + 高亮标注图」两张参考图
 * 并在 prompt 前注入区域指令，清空 maskDataUrl。完全在分发层完成，下游 provider /
 * BFF 无需感知 mask。注意效果是「软引导」而非像素级 inpaint，框外可能轻微漂移。
 */
async function applySoftMaskFallback(opts: CallApiOptions): Promise<CallApiOptions> {
  const target = opts.inputImageDataUrls[0]
  if (!opts.maskDataUrl || !target) return { ...opts, maskDataUrl: undefined }
  const annotated = await createMaskPreviewDataUrl(target, opts.maskDataUrl)
  return {
    ...opts,
    inputImageDataUrls: [target, annotated, ...opts.inputImageDataUrls.slice(1)],
    prompt: `${SOFT_MASK_INSTRUCTION}\n${opts.prompt}`,
    maskDataUrl: undefined,
  }
}

/**
 * 参数合法性的唯一强制执行点：任何提交路径（工作台 / canvas / 重试 / 恢复）到达
 * adapter 之前都过这个归一化，调用方不需要自觉。与 soft-mask 降级、防改写 guard
 * 同在分发层，同一模式。归一化幂等，上游已归一过的参数不受影响。
 */
function withNormalizedParams(opts: CallApiOptions): CallApiOptions {
  return {
    ...opts,
    params: normalizeParamsForSettings(opts.params, opts.settings, {
      hasInputImages: opts.inputImageDataUrls.length > 0,
    }),
  }
}

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  opts = withNormalizedParams(opts)

  const profile = getActiveApiProfile(opts.settings)
  if (!isByokGenerationEnabled() && profile.source !== 'builtin-edge') {
    throw new Error('当前部署只允许使用内置模型')
  }

  // 不支持原生 mask 的模型：把遮罩降级成「原图 + 高亮标注图 + prompt 指令」。
  // n>1 时上层已 fan-out 成多条 task，各自合成同一张标注图（输入相同、开销可接受），
  // 不做跨 task 缓存以避免缓存生命周期复杂度。
  if (opts.maskDataUrl && !modelSupportsNativeMask(profile)) {
    opts = await applySoftMaskFallback(opts)
  }

  // 防改写：与 soft mask 同样在分发层一次性改写 prompt，下游 adapter / BFF 无需感知。
  // Gemini 没有 prompt rewriting 概念（UI 也不展示该开关），不注入。
  if (opts.params.no_rewrite && clientProfileToApiProfile(profile).provider !== 'gemini') {
    opts = { ...opts, prompt: applyPromptRewriteGuard(opts.prompt) }
  }

  // sub2api 中继的 Codex 图片路径会丢弃 `size`，但模型会服从 prompt 中明确的构图；
  // 生成与编辑路径均已验证。
  if (!getParamCapabilities(profile, opts.params.output_format).size) {
    const instruction = buildAspectInstruction(opts.params.size)
    if (instruction) {
      opts = { ...opts, prompt: `${opts.prompt}\n\n${instruction}` }
    }
  }

  // 原生 mask 要求遮罩与主图同尺寸，缩放会破坏这个约定。
  if (!opts.maskDataUrl && opts.inputImageDataUrls.length) {
    opts = {
      ...opts,
      inputImageDataUrls: await compressInputImageDataUrls(opts.inputImageDataUrls),
    }
  }

  if (profile.source === 'builtin-edge') {
    const channel = getPublicChannel(profile.channelId)
    if (!channel) throw new Error(`找不到内置 channel：${profile.channelId}`)
    // builtin-edge 全部走 queue：浏览器 → BFF 都是 < 1s 短请求，永远绕开 CF Edge
    // ~60s 死线。生成 / 编辑 / mask 编辑都靠 BFF worker 调上游 /v1/images/edits
    // 或 /v1/images/generations 区分。
    if (toQueueProvider(channel.kind) === null) {
      throw new Error(`不支持的内置 channel kind：${channel.kind}`)
    }
    return callQueueChannelApi(opts, profile, channel)
  }

  // user-byok
  const byok = toByokAdapterProfile(profile)
  switch (profile.kind) {
    case 'gemini':
      return callGeminiImageApi(opts, byok)
    case 'openai-compat':
    case 'http-template':
      // http-template 暂走 OpenAI 兼容路径；未来若新增独立 adapter 在此分支替换。
      return callOpenAICompatibleImageApi(opts, byok, null)
    case 'openai-queue':
    case 'gemini-queue':
      throw new Error(
        `queue kind ${profile.kind} 仅用于 builtin-edge profile，不应作为 user-byok kind`,
      )
  }
}

/**
 * 刷新页面后用持久化的 bffRequestId 继续轮询。仅适用于 builtin-edge queue 路径。
 * 找不到对应 channel/profile 时抛错，由调用方写到 task.error。
 */
export async function resumeQueueImageApi(
  opts: CallApiOptions,
  requestId: string,
): Promise<CallApiResult> {
  opts = withNormalizedParams(opts)

  const profile = getActiveApiProfile(opts.settings)
  if (profile.source !== 'builtin-edge') {
    throw new Error('恢复 BFF queue 任务时未找到对应内置 channel profile')
  }
  const channel = getPublicChannel(profile.channelId)
  if (!channel) throw new Error(`找不到内置 channel：${profile.channelId}`)
  if (toQueueProvider(channel.kind) === null) {
    throw new Error(`channel kind ${channel.kind} 非 queue，无法恢复`)
  }
  return resumeQueueChannelApi(opts, profile, channel, requestId)
}
