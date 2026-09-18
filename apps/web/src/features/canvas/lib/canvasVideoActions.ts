import {
  VIDEO_DURATIONS,
  type VideoDeriveMode,
  type VideoDuration,
  type VideoGenerationRecord,
} from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { queueOutputUrl } from '../../../lib/channels/queueClient'
import {
  isVideoModeAvailable,
  type VideoModelOption,
  videoModelOptions,
} from '../../../lib/channels/videoChannels'
import { downloadBlob } from '../../../lib/downloadImages'
import { useStore } from '../../../store'
import { DERIVE_RESOLUTION, deriveSourceRefusal } from '../../video/lib/derive'
import { videoDeriveLabel, videoRejectionText } from '../../video/lib/labels'
import { useVideoStore } from '../../video/store'
import type { CanvasVideoRef } from './canvasDoc'
import type { CanvasEditor } from './editor'
import { placeImagesIntoTargets } from './placeholderShapeOps'
import { computePlaceholderTargets } from './placement'
import { rasterizeEntry } from './rasterizeSelection'
import {
  canvasVideoPromptRefusal,
  canvasVideoRequest,
  guardAllows,
  launchCanvasVideo,
} from './submitVideoFromCanvas'
import {
  type GenerationInputs,
  generationInputIds,
  inputIndices,
  pickGenerationInputs,
} from './videoInputs'
import { videoOptionRejection } from './videoRejection'

/**
 * 画布上的一段视频：元素 id、播放来源，以及用户当时在输入框里写的原话。
 * 原话只有画布自己发起的视频才有；智能体落的视频 `meta.prompt` 是面板上的标题，
 * 不是它生成时的提示词，拿它重发会出一段不相干的片子，所以这里是 null。
 */
export interface CanvasVideoNode {
  id: string
  video: CanvasVideoRef
  userPrompt: string | null
}

export function canvasVideoNode(editor: CanvasEditor, id: string): CanvasVideoNode | null {
  const element = editor.getElement(id)
  if (element?.type !== 'image' || !element.video) return null
  const meta = element.meta
  const typed = meta?.userPrompt
  // 画布生成栏发出去的是「文字标注 + 输入框」，userPrompt 只存了输入框那段；重新生成不再
  // 带选区标注，所以用完整的那段预填，片子的意思才对得上。智能体的 prompt 是标题，不以它结尾。
  const full =
    typed && meta?.prompt && meta.prompt !== typed && meta.prompt.endsWith(`\n${typed}`)
      ? meta.prompt
      : typed
  return { id, video: element.video, userPrompt: full ?? null }
}

/** 只选中了一段视频时才有节点工具条。 */
export function selectedCanvasVideo(editor: CanvasEditor): CanvasVideoNode | null {
  const ids = editor.getSelectedIds()
  return ids.length === 1 ? canvasVideoNode(editor, ids[0]!) : null
}

export type CanvasDeriveCheck =
  | { ok: true; option: VideoModelOption; sourceSeconds: number }
  | { ok: false; reason: string }

/**
 * 这段视频能不能续写 / 改视频。源片时长只能从生成记录里来：早于它的视频不知道多长，
 * 上游对源片时长有硬限，猜错就是一次白花的钱，所以直接说明做不了。
 */
export function canvasDeriveCheck(node: CanvasVideoNode, mode: VideoDeriveMode): CanvasDeriveCheck {
  const option = videoModelOptions().find((item) => item.support[mode])
  if (!option)
    return {
      ok: false,
      reason: i18next.t('derive.noModel', { ns: 'video', label: videoDeriveLabel(mode) }),
    }
  const seconds = node.video.generation?.duration
  if (seconds === undefined)
    return { ok: false, reason: i18next.t('videoToolbar.unknownSource', { ns: 'canvas' }) }
  const refusal = deriveSourceRefusal(mode, seconds)
  return refusal ? { ok: false, reason: refusal } : { ok: true, option, sourceSeconds: seconds }
}

function toast(message: string, kind: 'error' | 'success' | 'info' = 'error'): void {
  useStore.getState().showToast(message, kind)
}

/** 续写 / 改视频：结果放在源片右侧的空位，记下它从哪段、怎么派生来的。返回是否受理。 */
export async function submitCanvasDerive(
  editor: CanvasEditor,
  node: CanvasVideoNode,
  input: { mode: VideoDeriveMode; prompt: string; seconds: number },
): Promise<boolean> {
  const check = canvasDeriveCheck(node, input.mode)
  if (!check.ok) {
    toast(check.reason)
    return false
  }
  const prompt = input.prompt.trim()
  if (!prompt) {
    toast(i18next.t('store.emptyPrompt', { ns: 'video' }))
    return false
  }
  const generation: VideoGenerationRecord = {
    model: check.option.modelId,
    duration: input.seconds,
    aspectRatio: node.video.generation?.aspectRatio ?? '16:9',
    resolution: DERIVE_RESOLUTION,
    derivedFrom: { id: node.id, mode: input.mode },
  }
  try {
    const rejected = videoOptionRejection(
      generation.model,
      canvasVideoRequest(editor, generation),
      0,
    )
    if (rejected) {
      toast(videoRejectionText(rejected))
      return false
    }
    const tooLong = canvasVideoPromptRefusal(generation.model, prompt)
    if (tooLong) {
      toast(tooLong)
      return false
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err))
    return false
  }
  if (!guardAllows(generation)) return false
  const [target] = computePlaceholderTargets(
    editor,
    editor.getElementPageBounds(node.id) ?? null,
    1,
  )
  void launchCanvasVideo(editor, {
    prompt,
    userPrompt: prompt,
    frames: [],
    channelId: check.option.channelId,
    generation,
    target: target!,
  })
  return true
}

/** 这段视频能不能「重新生成」：部署得能出视频。 */
export function canvasRegenerateRefusal(): string | null {
  return isVideoModeAvailable()
    ? null
    : i18next.t('videoToolbar.videoUnavailable', { ns: 'canvas' })
}

/**
 * 把一段视频的生成记录载进视频草稿（模型、档位），弹窗与生成栏读的都是这份草稿。
 * 原模型在当前部署不可用就不动草稿：换个模型档位矩阵就不一样了，硬套只会被夹成另一套参数。
 */
export function loadGenerationIntoDraft(generation: VideoGenerationRecord): boolean {
  if (!videoModelOptions().some((one) => one.modelId === generation.model)) return false
  const video = useVideoStore.getState()
  video.setModel(generation.model)
  video.setResolution(generation.resolution)
  if ((VIDEO_DURATIONS as readonly number[]).includes(generation.duration))
    video.setDuration(generation.duration as VideoDuration)
  video.setAspectRatio(generation.aspectRatio)
  return true
}

/**
 * 原来的输入图（首尾帧与参考图）是否都还在画布上。齐了就原样沿用；缺一张就整组不带，
 * 只按文字生成——少了哪张都不是原来那段片子，弹窗事先写明。
 */
export function regenerateInputs(editor: CanvasEditor, node: CanvasVideoNode) {
  const generation = node.video.generation
  const recorded = generation ? generationInputIds(generation) : []
  const complete = recorded.every((id) => editor.getElement(id)?.type === 'image')
  const inputs: GenerationInputs = generation && complete ? pickGenerationInputs(generation) : {}
  return { recorded, present: complete ? recorded : [], complete, inputs }
}

/** 所选模型与档位接不接得住要沿用的输入图；接不住给出弹窗里用的说明。 */
export function regenerateInputRefusal(
  inputs: GenerationInputs,
  draft: Pick<VideoGenerationRecord, 'model' | 'duration' | 'aspectRatio' | 'resolution'>,
): string | null {
  const count = generationInputIds(inputs).length
  if (count === 0 || !videoModelOptions().some((one) => one.modelId === draft.model)) return null
  const rejected = videoOptionRejection(
    draft.model,
    {
      duration_seconds: draft.duration,
      aspect_ratio: draft.aspectRatio,
      resolution: draft.resolution,
      ...inputIndices(inputs),
    },
    count,
  )
  return rejected ? videoRejectionText(rejected) : null
}

/**
 * 改参数重新生成一段普通生成的视频：按视频草稿里此刻的模型与档位、弹窗里的描述，
 * 原输入图都还在就沿用（干净栅格化，不带标注），不齐就只按文字生成——弹窗事先写明了。
 * 结果放在原视频右侧。返回是否受理。
 */
export async function regenerateCanvasVideo(
  editor: CanvasEditor,
  node: CanvasVideoNode,
  userPrompt: string,
  options: { keepFrames?: boolean; isCurrent?: () => boolean } = {},
): Promise<boolean> {
  const refuse = (message: string) => {
    toast(message)
    return false
  }
  const unavailable = canvasRegenerateRefusal()
  if (unavailable) return refuse(unavailable)
  const draft = useVideoStore.getState().draft
  const option = videoModelOptions().find((one) => one.modelId === draft.model)
  if (!option) return refuse(i18next.t('error.noModel', { ns: 'video' }))
  const prompt = userPrompt.trim()
  if (!prompt) return refuse(i18next.t('store.emptyPrompt', { ns: 'video' }))
  const inputs = options.keepFrames === false ? {} : regenerateInputs(editor, node).inputs
  const present = generationInputIds(inputs)
  const generation: VideoGenerationRecord = {
    model: option.modelId,
    duration: draft.duration,
    aspectRatio: draft.aspectRatio,
    resolution: draft.resolution,
    ...inputs,
  }
  const rejected = videoOptionRejection(
    generation.model,
    canvasVideoRequest(editor, generation),
    present.length,
  )
  if (rejected) return refuse(videoRejectionText(rejected))
  const tooLong = canvasVideoPromptRefusal(generation.model, prompt)
  if (tooLong) return refuse(tooLong)
  if (!guardAllows(generation)) return false
  const rasterized = await Promise.all(
    present.map((id) => {
      const box = editor.getElementPageBounds(id)
      return box ? rasterizeEntry(editor, { imageId: id, box, graphicIds: [] }) : null
    }),
  )
  const frames = rasterized.filter((one): one is string => one !== null)
  if (frames.length !== present.length)
    return refuse(i18next.t('videoToolbar.framesFailed', { ns: 'canvas' }))
  // 弹窗在栅格化期间被关掉了：用户已经放弃这次，不能再替他花钱。
  if (options.isCurrent && !options.isCurrent()) return false
  const [target] = computePlaceholderTargets(
    editor,
    editor.getElementPageBounds(node.id) ?? null,
    1,
  )
  void launchCanvasVideo(editor, {
    prompt,
    userPrompt: prompt,
    frames,
    channelId: option.channelId,
    generation,
    target: target!,
  })
  return true
}

const FRAME_TIMEOUT_MS = 20_000

/** 在浏览器里取这段视频的首帧或尾帧。取不到（跨域污染、超时、解码失败）返回 null。 */
export function captureCanvasVideoFrame(
  video: CanvasVideoRef,
  which: 'first' | 'last',
): Promise<string | null> {
  return new Promise((resolve) => {
    const element = document.createElement('video')
    const listeners = new AbortController()
    let settled = false
    const settle = (frame: string | null) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      listeners.abort()
      element.removeAttribute('src')
      element.load()
      resolve(frame)
    }
    const timer = window.setTimeout(() => settle(null), FRAME_TIMEOUT_MS)
    const { signal } = listeners
    element.crossOrigin = 'use-credentials'
    element.preload = 'auto'
    element.muted = true
    element.addEventListener(
      'loadedmetadata',
      () => {
        if (which === 'first') {
          element.currentTime = 0.001
          return
        }
        // 流式响应拿不到时长（Infinity / NaN），没法定位末尾，直接判失败而不是干等超时。
        if (!Number.isFinite(element.duration)) return settle(null)
        // 尾帧取在末尾前一点：正好落在 duration 上时不少浏览器给的是黑帧或不触发 seeked。
        element.currentTime = Math.max(0, element.duration - 0.05)
      },
      { signal },
    )
    element.addEventListener('seeked', () => settle(framePng(element)), { signal })
    element.addEventListener('error', () => settle(null), { signal })
    element.src = queueOutputUrl(video.taskId, video.outputIndex)
    element.load()
  })
}

/** 截帧用 PNG：它多半要当下一段的首帧再送上游，有损压一次就少一分画质。 */
function framePng(video: HTMLVideoElement): string | null {
  const { videoWidth: width, videoHeight: height } = video
  if (!width || !height) return null
  try {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(video, 0, 0, width, height)
    // 跨域没配好会污染画布，toDataURL 直接抛。
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}

/** 截下首帧 / 尾帧，作为新图片放在视频右侧，可以直接当下一段的首帧。 */
export async function placeCanvasVideoFrame(
  editor: CanvasEditor,
  node: CanvasVideoNode,
  which: 'first' | 'last',
): Promise<boolean> {
  const frame = await captureCanvasVideoFrame(node.video, which)
  if (!frame || !editor.getElement(node.id)) {
    toast(i18next.t('videoToolbar.frameFailed', { ns: 'canvas' }))
    return false
  }
  const [target] = computePlaceholderTargets(
    editor,
    editor.getElementPageBounds(node.id) ?? null,
    1,
  )
  await placeImagesIntoTargets(editor, [{ dataUrl: frame }], [target!], {
    meta: { frameOf: node.id, frame: which },
  })
  return true
}

/** 下载这段视频的 mp4。播放地址要带登录态，不能直接给 `<a href>`。 */
export async function downloadCanvasVideo(node: CanvasVideoNode): Promise<void> {
  try {
    const res = await authenticatedBffFetch(
      queueOutputUrl(node.video.taskId, node.video.outputIndex),
    )
    if (!res.ok)
      throw new Error(i18next.t('download.fetchFailed', { ns: 'video', status: res.status }))
    downloadBlob(await res.blob(), `video-${node.video.taskId}-${node.video.outputIndex}.mp4`)
  } catch (err) {
    toast(
      err instanceof Error
        ? err.message
        : i18next.t('videoToolbar.downloadFailed', { ns: 'canvas' }),
    )
  }
}
