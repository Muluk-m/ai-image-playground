import {
  type VideoGenerationRecord,
  type VideoRequest,
  videoPromptRejection,
  videoRateMultiplier,
  videoRequestRejection,
} from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { getStoredChannel } from '../../../lib/channels/channelStore'
import { awaitQueueOutputs, submitVideoRequest } from '../../../lib/channels/queueClient'
import { videoModelOptions } from '../../../lib/channels/videoChannels'
import {
  getPrivateSubmissionGuard,
  notifyPrivateSubmissionAccepted,
  notifyPrivateSubmissionError,
  notifyPrivateSubmissionSettled,
} from '../../../lib/privateOverlay'
import { useStore } from '../../../store'
import { videoOutputFrame } from '../../agent/lib/artifactSource'
import { blankVideoPoster } from '../../agent/lib/videoPoster'
import { videoRejectionText } from '../../video/lib/labels'
import { useVideoStore } from '../../video/store'
import type { VideoDraft } from '../../video/types'
import { type CanvasVideoRefusal, planVideoFrames } from './canvasVideoPlan'
import type { CanvasEditor, PlaceholderView } from './editor'
import { Box } from './geometry'
import {
  errorMessage,
  markPlaceholderStatus,
  placeImagesIntoTargets,
  targetFromShape,
} from './placeholderShapeOps'
import { computePlaceholderTargets, type PlacementTarget } from './placement'
import { analyzeSelection, type CanvasInputEntry, rasterizeEntry } from './rasterizeSelection'
import {
  generationInputIds,
  generationInputs,
  inputIndices,
  type VideoInputItem,
} from './videoInputs'

/**
 * 画布视频任务的内存运行态：首尾帧位图。它不进占位框 meta（几 MB 的 data URL 不该随画布
 * 持久化），所以只够同一次打开里的重试用；刷新后续跑只认 `bffRequestId`，不必重传。
 * 出片落地才释放：失败态的占位框还要拿它原样重试。
 */
const frameHandles = new Map<string, string[]>()

export interface CanvasVideoLaunch {
  prompt: string
  /** 输入框原话（不含文字标注）。续写 / 改视频就是弹窗里写的那句。 */
  userPrompt: string
  frames: string[]
  channelId: string
  generation: VideoGenerationRecord
  target: PlacementTarget
}

function toast(message: string): void {
  useStore.getState().showToast(message, 'error')
}

export function canvasVideoRefusalText(reason: CanvasVideoRefusal, model: string): string {
  switch (reason) {
    case 'videoSelected':
      return i18next.t('video.refuse.videoSelected', { ns: 'canvas' })
    case 'tooManyImages':
      return i18next.t('video.refuse.tooManyImages', { ns: 'canvas' })
    case 'firstFrameUnsupported':
      return i18next.t('video.refuse.firstFrameUnsupported', { ns: 'canvas', model })
    case 'lastFrameUnsupported':
      return i18next.t('video.refuse.lastFrameUnsupported', { ns: 'canvas', model })
  }
}

/**
 * 送给队列的视频档位。输入图按首帧、尾帧、参考图的顺序排在 input_images 里（见 `inputIndices`）。
 * 续写 / 改视频不带图，改带源片在队列里的 id；源片是画布上的对象，到提交这一刻才去取，
 * 它已经不在画布上就明说，不当成普通生成发出去。
 */
export function canvasVideoRequest(
  editor: CanvasEditor,
  generation: VideoGenerationRecord,
): VideoRequest {
  const base: VideoRequest = {
    duration_seconds: generation.duration,
    aspect_ratio: generation.aspectRatio,
    resolution: generation.resolution,
  }
  if (generation.derivedFrom) {
    const source = editor.getElement(generation.derivedFrom.id)
    if (source?.type !== 'image' || !source.video)
      throw new Error(i18next.t('videoToolbar.sourceGone', { ns: 'canvas' }))
    return {
      ...base,
      mode: generation.derivedFrom.mode,
      source_task_id: source.video.taskId,
      source_output_index: source.video.outputIndex,
    }
  }
  return { ...base, ...inputIndices(generation) }
}

/** 视频档实际送出的描述：文字标注在前、输入框在后。 */
export function canvasVideoPrompt(editor: CanvasEditor, userPrompt: string): string {
  const selection = analyzeSelection(editor)
  return [selection?.annotationText ?? '', userPrompt.trim()].filter(Boolean).join('\n')
}

/** 描述对这个模型是否过长。生成栏据此禁用按钮，提交时再判一次。 */
export function canvasVideoPromptRefusal(model: string, prompt: string): string | null {
  const found = videoPromptRejection(model, prompt)
  return found ? videoRejectionText(found) : null
}

function candidatesOf(editor: CanvasEditor) {
  const plan = analyzeSelection(editor)
  return (plan?.entries ?? []).map((entry) => {
    const element = editor.getElement(entry.imageId)
    return { entry, video: element?.type === 'image' && Boolean(element.video) }
  })
}

/** 「选中即参考」的入口：选区里有图且没有视频时返回这些图，否则 null。 */
export function referenceSelection(editor: CanvasEditor): CanvasInputEntry[] | null {
  const candidates = candidatesOf(editor)
  if (candidates.length === 0 || candidates.some((one) => one.video)) return null
  return candidates.map((one) => one.entry)
}

/** 选区此刻在视频档下能不能提交，不能就给出原因。生成栏据此禁用按钮。 */
export function canvasVideoSelectionRefusal(editor: CanvasEditor, model: string): string | null {
  const option = videoModelOptions().find((one) => one.modelId === model)
  if (!option) return i18next.t('error.noModel', { ns: 'video' })
  const plan = planVideoFrames(candidatesOf(editor), option.support)
  return plan.ok ? null : canvasVideoRefusalText(plan.reason, option.label)
}

/**
 * 生成栏视频档的提交：按视频参数草稿当前的模型与档位，把选区读成文生 / 首帧 / 首尾帧。
 * 校验、门禁都在占位框出现之前做完；过不了就 toast 说明，不留空框。
 * 返回是否受理：没受理时生成栏保留输入，写好的长描述不能因为一次拒绝就没了。
 */
export async function submitVideoFromCanvas(
  editor: CanvasEditor,
  userPrompt: string,
): Promise<boolean> {
  const refuse = (message: string) => {
    toast(message)
    return false
  }
  const draft = useVideoStore.getState().draft
  const option = videoModelOptions().find((one) => one.modelId === draft.model)
  if (!option) return refuse(i18next.t('error.noModel', { ns: 'video' }))

  const plan = planVideoFrames(candidatesOf(editor), option.support)
  if (!plan.ok) return refuse(canvasVideoRefusalText(plan.reason, option.label))

  const prompt = canvasVideoPrompt(editor, userPrompt)
  if (!prompt) return refuse(i18next.t('store.emptyPrompt', { ns: 'video' }))

  const generation: VideoGenerationRecord = {
    model: option.modelId,
    duration: draft.duration,
    aspectRatio: draft.aspectRatio,
    resolution: draft.resolution,
    ...(plan.frames[0] ? { firstFrameId: plan.frames[0].imageId } : {}),
    ...(plan.frames[1] ? { lastFrameId: plan.frames[1].imageId } : {}),
  }
  const frameCount = plan.frames.length
  const rejected = videoRequestRejection(
    option.modelId,
    canvasVideoRequest(editor, generation),
    frameCount,
  )
  if (rejected) return refuse(videoRejectionText(rejected))
  const tooLong = canvasVideoPromptRefusal(option.modelId, prompt)
  if (tooLong) return refuse(tooLong)
  if (!guardAllows(generation)) return false

  // 首尾帧会原样出现在成片里：图上的圈和箭头不画进去，标注只以文字进描述。
  const rasterized = await Promise.all(
    plan.frames.map((entry) => rasterizeEntry(editor, { ...entry, graphicIds: [] })),
  )
  const frames = rasterized.filter((one): one is string => one !== null)
  // 少一帧就不是用户要的那段片子：宁可不发，也不静默退化成文生。
  if (frames.length !== frameCount)
    return refuse(i18next.t('submit.rasterizeFailed', { ns: 'canvas' }))

  const anchor = frameCount ? Box.Common(plan.frames.map((entry) => entry.box)) : null
  const [target] = computePlaceholderTargets(editor, anchor, 1)
  void launchCanvasVideo(editor, {
    prompt,
    userPrompt: userPrompt.trim(),
    frames,
    channelId: option.channelId,
    generation,
    target: target!,
  })
  return true
}

/**
 * 「选中即参考」面板这一刻能不能提交，不能就给出原因（面板上显示并禁用按钮）。
 * 走的是 BFF 同一份校验：上限、清晰度封顶、能不能和首尾帧同用都由模型矩阵决定。
 */
export function referenceVideoRefusal(
  items: readonly VideoInputItem[],
  draft: VideoDraft,
): string | null {
  const option = videoModelOptions().find((one) => one.modelId === draft.model)
  if (!option) return i18next.t('error.noModel', { ns: 'video' })
  const generation = referenceGeneration(option.modelId, items, draft)
  const rejected = videoRequestRejection(
    option.modelId,
    {
      duration_seconds: draft.duration,
      aspect_ratio: draft.aspectRatio,
      resolution: draft.resolution,
      ...inputIndices(generation),
    },
    items.length,
  )
  return rejected ? videoRejectionText(rejected) : null
}

function referenceGeneration(
  model: string,
  items: readonly VideoInputItem[],
  draft: VideoDraft,
): VideoGenerationRecord {
  return {
    model,
    duration: draft.duration,
    aspectRatio: draft.aspectRatio,
    resolution: draft.resolution,
    ...generationInputs(items),
  }
}

/**
 * 「选中即参考」的提交：面板排好的输入图按角色送出，参考图保持面板顺序。占位落在这些图的右侧。
 * 返回是否受理；没受理时面板保留输入。
 */
export async function submitReferenceVideo(
  editor: CanvasEditor,
  items: readonly VideoInputItem[],
  userPrompt: string,
): Promise<boolean> {
  const refuse = (message: string) => {
    toast(message)
    return false
  }
  const draft = useVideoStore.getState().draft
  const option = videoModelOptions().find((one) => one.modelId === draft.model)
  if (!option) return refuse(i18next.t('error.noModel', { ns: 'video' }))
  const refusal = referenceVideoRefusal(items, draft)
  if (refusal) return refuse(refusal)
  const prompt = canvasVideoPrompt(editor, userPrompt)
  if (!prompt) return refuse(i18next.t('store.emptyPrompt', { ns: 'video' }))
  const tooLong = canvasVideoPromptRefusal(option.modelId, prompt)
  if (tooLong) return refuse(tooLong)
  const generation = referenceGeneration(option.modelId, items, draft)
  if (!guardAllows(generation)) return false

  // 输入图按提交顺序栅格化：首帧、尾帧、参考图。图上的圈和箭头不画进去，标注只以文字进描述。
  const byId = new Map(items.map((item) => [item.entry.imageId, item.entry]))
  const ordered = generationInputIds(generation).map((id) => byId.get(id)!)
  const rasterized = await Promise.all(
    ordered.map((entry) => rasterizeEntry(editor, { ...entry, graphicIds: [] })),
  )
  const inputs = rasterized.filter((one): one is string => one !== null)
  if (inputs.length !== ordered.length)
    return refuse(i18next.t('submit.rasterizeFailed', { ns: 'canvas' }))

  const anchor = Box.Common(items.map((item) => item.entry.box))
  const [target] = computePlaceholderTargets(editor, anchor, 1)
  void launchCanvasVideo(editor, {
    prompt,
    userPrompt: userPrompt.trim(),
    frames: inputs,
    channelId: option.channelId,
    generation,
    target: target!,
  })
  return true
}

export function guardAllows(generation: VideoGenerationRecord): boolean {
  const guard = getPrivateSubmissionGuard({
    model: generation.model,
    quantity: generation.duration,
    unitMultiplier: videoRateMultiplier(generation.model, generation.resolution),
  })
  if (!guard.blocked) return true
  toast(guard.disabledReason ?? i18next.t('submit.blocked', { ns: 'canvas' }))
  guard.blockedAction?.run()
  return false
}

export async function launchCanvasVideo(
  editor: CanvasEditor,
  launch: CanvasVideoLaunch,
): Promise<void> {
  const taskId = crypto.randomUUID()
  const clientRequestId = crypto.randomUUID()
  const placeholderId = editor.createPlaceholder(launch.target, {
    taskId,
    clientRequestId,
    source: 'builtin-edge',
    prompt: launch.prompt,
    userPrompt: launch.userPrompt,
    inputCount: launch.frames.length,
    video: { channelId: launch.channelId, generation: launch.generation },
  })
  frameHandles.set(taskId, launch.frames)
  try {
    const channel = getStoredChannel(launch.channelId)
    if (!channel) throw new Error(i18next.t('error.noModel', { ns: 'video' }))
    const requestId = await submitVideoRequest({
      channel,
      model: launch.generation.model,
      prompt: launch.prompt,
      video: canvasVideoRequest(editor, launch.generation),
      inputImageDataUrls: launch.frames,
      clientRequestId,
    })
    // 回填即持久化：刷新后恢复只认它，不必也不能重传首尾帧。
    editor.updatePlaceholder(placeholderId, { meta: { bffRequestId: requestId } })
    notifyPrivateSubmissionAccepted()
    await settleCanvasVideo(editor, placeholderId, requestId, launch.generation, launch.target)
    frameHandles.delete(taskId)
  } catch (err) {
    notifyPrivateSubmissionError(err)
    markPlaceholderStatus(editor, placeholderId, 'error', errorMessage(err))
  } finally {
    notifyPrivateSubmissionSettled()
  }
}

/**
 * 等队列出片并换下占位框。提交与刷新后的续跑共用这一段。占位框在生成中被删了也照样落：
 * 片子已经出了、也计了费，它得落在原位置，不能悄悄丢掉。
 */
export async function settleCanvasVideo(
  editor: CanvasEditor,
  placeholderId: string,
  requestId: string,
  generation: VideoGenerationRecord,
  fallback: PlacementTarget,
): Promise<void> {
  const [output] = await awaitQueueOutputs(requestId)
  const source = { taskId: requestId, outputIndex: output!.index }
  const poster =
    (await videoOutputFrame(source)) ??
    blankVideoPoster({ width: output!.width, height: output!.height })
  const placeholder = editor.getPlaceholder(placeholderId)
  await placeImagesIntoTargets(
    editor,
    [{ dataUrl: poster, video: { ...source, generation } }],
    [placeholder ? targetFromShape(placeholder) : fallback],
    // 不改选区：选中新视频会让视频档立刻判「选中的是视频」，挡住接着生下一段。
    {
      ...(placeholder
        ? {
            meta: {
              prompt: placeholder.meta.prompt,
              ...(placeholder.meta.userPrompt !== undefined
                ? { userPrompt: placeholder.meta.userPrompt }
                : {}),
            },
          }
        : {}),
      select: false,
    },
  )
  // 落成功才收占位框：中途失败它得留着，错误态才有处可标。
  if (placeholder) editor.deleteElement(placeholderId)
}

/** 刷新后续跑一条已提交的画布视频任务。 */
export async function resumeCanvasVideo(
  editor: CanvasEditor,
  placeholder: PlaceholderView,
  requestId: string,
): Promise<void> {
  const video = placeholder.meta.video
  if (!video) return
  try {
    await settleCanvasVideo(
      editor,
      placeholder.id,
      requestId,
      video.generation,
      targetFromShape(placeholder),
    )
  } catch (err) {
    notifyPrivateSubmissionError(err)
    markPlaceholderStatus(editor, placeholder.id, 'error', errorMessage(err))
  } finally {
    // 续跑出片同样要让余额与充值入口刷新。
    notifyPrivateSubmissionSettled()
  }
}

/**
 * 失败或失效的视频占位框「重试」：同档位、同首尾帧重新提交。首尾帧只在本次打开的内存里；
 * 刷新后丢了就明说，不退化成文生。
 */
export function retryCanvasVideo(editor: CanvasEditor, placeholder: PlaceholderView): void {
  const { meta } = placeholder
  if (!meta.video) return
  const frames = frameHandles.get(meta.taskId) ?? []
  if ((meta.inputCount ?? 0) > 0 && frames.length === 0) {
    toast(i18next.t('submit.inputsLost', { ns: 'canvas' }))
    return
  }
  // 派生片的源片可能已经删了：先判，别删掉占位框再告诉用户做不了。
  try {
    canvasVideoRequest(editor, meta.video.generation)
  } catch (err) {
    toast(errorMessage(err))
    return
  }
  if (!guardAllows(meta.video.generation)) return
  editor.deleteElement(placeholder.id)
  // 帧交给新任务，旧 key 随之作废。
  frameHandles.delete(meta.taskId)
  void launchCanvasVideo(editor, {
    prompt: meta.prompt,
    userPrompt: meta.userPrompt ?? meta.prompt,
    frames,
    channelId: meta.video.channelId,
    generation: meta.video.generation,
    target: targetFromShape(placeholder),
  })
}
