import { type VideoMode, type VideoResolution } from '@image-playground/shared'
import type { HydratedSubmitRequest, HydratedVideoRequest } from '../imageArchive'
import { isObject } from '../type-guards'
import {
  AsyncTaskProtocol,
  AsyncTaskState,
  readTaskIdField,
  videoStatusReader,
} from './async-tasks'
import { UpstreamResultUnknownError } from './errors'
import { inlineDataPart } from './gemini'
import { ChannelRouteStyle, clientError } from './shared'

/**
 * 成片的取法：`public` 交给归档回源，`credentialed` 要在上游路径内带 key 再取一次字节
 * （上游把成片锁在自己域里，归档那一步没有凭据）。
 */
type VideoOutcome = {
  readonly kind: 'public' | 'credentialed'
  readonly url: string
  readonly durationSeconds: number
}

interface VideoStyleSpec {
  /** 上游实际接受的模式；档位表已在 submit 拦过一遍，这里是发请求前的最后一道。 */
  readonly modes: readonly VideoMode[]
  protocol(args: { base: string; model: string; mode: VideoMode }): AsyncTaskProtocol
  body(
    model: string,
    request: HydratedSubmitRequest,
    video: HydratedVideoRequest,
    mode: VideoMode,
  ): Record<string, unknown>
  result(base: string, payload: unknown, video: HydratedVideoRequest): VideoOutcome
}

export const VIDEO_STYLE_SPECS: Partial<Record<ChannelRouteStyle, VideoStyleSpec>> = {
  'grok-videos': {
    modes: ['generate', 'extend', 'edit'],
    protocol: ({ base, mode }) => grokVideoProtocol(base, mode),
    body: buildGrokVideoBody,
    result: grokVideoResult,
  },
  'agnes-videos': {
    modes: ['generate'],
    protocol: ({ base, model }) => agnesVideoProtocol(base, model),
    body: buildAgnesVideoBody,
    result: agnesVideoResult,
  },
  'ark-videos': {
    modes: ['generate'],
    protocol: ({ base }) => arkVideoProtocol(base),
    body: buildArkVideoBody,
    result: arkVideoResult,
  },
  'veo-videos': {
    modes: ['generate'],
    protocol: ({ base, model }) => veoVideoProtocol(base, model),
    body: buildVeoVideoBody,
    result: veoVideoResult,
  },
}

const GROK_VIDEO_SUBMIT_PATHS: Record<VideoMode, string> = {
  generate: 'videos/generations',
  extend: 'videos/extensions',
  edit: 'videos/edits',
}

function grokVideoProtocol(base: string, mode: VideoMode): AsyncTaskProtocol {
  return {
    submitUrl: `${base}/${GROK_VIDEO_SUBMIT_PATHS[mode]}`,
    pollUrl: (taskId) => `${base}/videos/${encodeURIComponent(taskId)}`,
    readTaskId: (payload) => readTaskIdField(payload, ['request_id', 'id']),
    readState: readGrokVideoState,
  }
}

/** Agnes 的轮询端点挂在网关根上，不在 /v1 下 —— 用 base 的 origin 重新拼，别接相对路径。 */
function agnesVideoProtocol(base: string, model: string): AsyncTaskProtocol {
  const origin = new URL(base).origin
  return {
    submitUrl: `${base}/videos`,
    pollUrl: (taskId) =>
      `${origin}/agnesapi?video_id=${encodeURIComponent(taskId)}&model_name=${encodeURIComponent(model)}`,
    readTaskId: (payload) => readTaskIdField(payload, ['video_id', 'task_id', 'id']),
    readState: readAgnesVideoState,
  }
}

function arkVideoProtocol(base: string): AsyncTaskProtocol {
  const tasks = `${base}/contents/generations/tasks`
  return {
    submitUrl: tasks,
    pollUrl: (taskId) => `${tasks}/${encodeURIComponent(taskId)}`,
    readTaskId: (payload) => readTaskIdField(payload, ['id']),
    readState: readArkVideoState,
  }
}

/**
 * Veo 的任务 id 就是 operation name（`models/<model>/operations/<id>` 形状），
 * 轮询地址是 base 直接拼它——带斜杠，不能 encodeURIComponent。
 */
function veoVideoProtocol(base: string, model: string): AsyncTaskProtocol {
  return {
    submitUrl: `${base}/models/${model}:predictLongRunning`,
    pollUrl: (taskId) => `${base}/${taskId}`,
    readTaskId: (payload) => readTaskIdField(payload, ['name']),
    readState: readVeoVideoState,
  }
}

export const VIDEO_MIME = 'video/mp4'

const readGrokVideoState = videoStatusReader(
  ['done', 'succeeded', 'completed'],
  ['failed', 'error', 'expired', 'cancelled'],
)

const readAgnesVideoState = videoStatusReader(['completed'], ['failed'])

const readArkVideoState = videoStatusReader(['succeeded'], ['failed', 'cancelled', 'expired'])

/** operation 没有 status 字段：`done` 之前一律继续轮，`done` 带 error 是终态失败。 */
function readVeoVideoState(payload: unknown): AsyncTaskState {
  if (!isObject(payload) || payload.done !== true) return { kind: 'pending' }
  if (payload.error) return { kind: 'failed', status: null }
  return { kind: 'completed', payload }
}

/** 内容端点给的是网关相对路径，按 baseUrl 解析成绝对地址。 */
function grokVideoResult(
  base: string,
  payload: unknown,
  video: HydratedVideoRequest,
): VideoOutcome {
  const body = (payload as { video?: { url?: unknown; duration?: unknown } } | null)?.video
  if (typeof body?.url !== 'string' || body.url.length === 0)
    throw new UpstreamResultUnknownError('Grok 视频任务已完成但未返回内容地址')
  const duration = body.duration
  return {
    kind: 'credentialed',
    url: new URL(body.url, base).toString(),
    durationSeconds:
      typeof duration === 'number' && duration > 0 ? duration : video.duration_seconds,
  }
}

/** 成片地址已经是绝对地址的上游共用的收口；时长按提交值记。 */
function absoluteVideoOutcome(
  kind: VideoOutcome['kind'],
  url: unknown,
  video: HydratedVideoRequest,
  label: string,
): VideoOutcome {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url))
    throw new UpstreamResultUnknownError(`${label} 视频任务已完成但未返回结果地址`)
  return { kind, url, durationSeconds: video.duration_seconds }
}

function agnesVideoResult(_base: string, payload: unknown, video: HydratedVideoRequest) {
  const body = (payload ?? {}) as { url?: unknown; metadata?: { url?: unknown } }
  const url = [body.url, body.metadata?.url].find(
    (value): value is string => typeof value === 'string' && /^https?:\/\//i.test(value),
  )
  return absoluteVideoOutcome('public', url, video, 'Agnes')
}

function arkVideoResult(_base: string, payload: unknown, video: HydratedVideoRequest) {
  const content = (payload as { content?: { video_url?: unknown } } | null)?.content
  return absoluteVideoOutcome('public', content?.video_url, video, 'Seedance')
}

type VeoOperation = {
  response?: { generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: unknown } }> } }
}

/** 成片在 Google 域内，取字节要带同一把 key；链接两天后失效，所以必须归档到自己的存储。 */
function veoVideoResult(_base: string, payload: unknown, video: HydratedVideoRequest) {
  const uri = (payload as VeoOperation | null)?.response?.generateVideoResponse
    ?.generatedSamples?.[0]?.video?.uri
  return absoluteVideoOutcome('credentialed', uri, video, 'Veo')
}

/** 首尾帧指向同一请求的 input_images；hydrate 之后它们已经是 data URL。 */
function videoFrame(request: HydratedSubmitRequest, index: number | undefined): string | undefined {
  if (index === undefined) return undefined
  return request.input_images?.[index]
}

/** 参考图按用户排好的顺序取；下标由提交校验保证落在输入图里。 */
function videoReferences(request: HydratedSubmitRequest, video: HydratedVideoRequest): string[] {
  return (video.reference_image_indices ?? [])
    .map((index) => request.input_images?.[index])
    .filter((url): url is string => typeof url === 'string')
}

/** 有首帧或参考图时上游要求换到 1.5：文生的那个既不吃 image，也不吃 reference_images。 */
const GROK_VIDEO_IMAGE_MODEL = 'grok-imagine-video-1.5'

function buildGrokVideoBody(
  model: string,
  request: HydratedSubmitRequest,
  video: HydratedVideoRequest,
  mode: VideoMode,
): Record<string, unknown> {
  if (mode !== 'generate') {
    if (!video.source_video) throw clientError('续写和改视频缺少源视频')
    return {
      model,
      prompt: request.prompt,
      video: { url: video.source_video },
      // edit 的时长跟随源片，上游不接受 duration。
      ...(mode === 'extend' ? { duration: video.duration_seconds } : {}),
    }
  }
  const firstFrame = videoFrame(request, video.first_frame_index)
  const references = videoReferences(request, video)
  return {
    model: firstFrame || references.length ? GROK_VIDEO_IMAGE_MODEL : model,
    prompt: request.prompt,
    duration: video.duration_seconds,
    aspect_ratio: video.aspect_ratio,
    resolution: video.resolution,
    ...(firstFrame ? { image: { url: firstFrame } } : {}),
    ...(references.length ? { reference_images: references.map((url) => ({ url })) } : {}),
  }
}

const AGNES_VIDEO_SIZES: Record<VideoResolution, string> = {
  '720p': '720P',
  '1080p': '1080P',
  '2k': '2K',
}

function buildAgnesVideoBody(
  model: string,
  request: HydratedSubmitRequest,
  video: HydratedVideoRequest,
): Record<string, unknown> {
  const firstFrame = videoFrame(request, video.first_frame_index)
  const lastFrame = videoFrame(request, video.last_frame_index)
  return {
    model,
    prompt: request.prompt,
    seconds: String(video.duration_seconds),
    mode: firstFrame || lastFrame ? 'keyframe' : 'text',
    size: AGNES_VIDEO_SIZES[video.resolution],
    aspect_ratio: video.aspect_ratio,
    ...(firstFrame ? { first_frame: firstFrame } : {}),
    ...(lastFrame ? { last_frame: lastFrame } : {}),
  }
}

/** 方舟的 ratio / resolution token 跟我们的档位同名，直接透传，别再加一层映射。 */
function buildArkVideoBody(
  model: string,
  request: HydratedSubmitRequest,
  video: HydratedVideoRequest,
): Record<string, unknown> {
  const frame = (role: string, index: number | undefined): Record<string, unknown>[] => {
    const url = videoFrame(request, index)
    return url ? [{ type: 'image_url', image_url: { url }, role }] : []
  }
  return {
    model,
    content: [
      { type: 'text', text: request.prompt },
      ...frame('first_frame', video.first_frame_index),
      ...frame('last_frame', video.last_frame_index),
      // 提示词里的「图片 n」按 content 里 image_url 的顺序数，所以参考图保持用户排好的顺序。
      // 这依赖矩阵里 Seedance 的 withFrames:false：帧与参考图同时出现时，帧会占掉前面的编号。
      ...videoReferences(request, video).map((url) => ({
        type: 'image_url',
        image_url: { url },
        role: 'reference_image',
      })),
    ],
    ratio: video.aspect_ratio,
    duration: video.duration_seconds,
    resolution: video.resolution,
    watermark: false,
  }
}

function buildVeoVideoBody(
  _model: string,
  request: HydratedSubmitRequest,
  video: HydratedVideoRequest,
): Record<string, unknown> {
  const firstFrame = videoFrame(request, video.first_frame_index)
  const image = firstFrame ? inlineDataPart(firstFrame) : undefined
  if (firstFrame && !image) throw clientError('首帧图片不是合法的数据 URL')
  return {
    instances: [{ prompt: request.prompt, ...(image ? { image } : {}) }],
    parameters: {
      aspectRatio: video.aspect_ratio,
      // 上游只认字符串秒数，数字会被拒。
      durationSeconds: String(video.duration_seconds),
      resolution: video.resolution,
      // 上游按模式固定这个值：文生放开，带人像首帧的只允许成人。
      personGeneration: image ? 'allow_adult' : 'allow_all',
    },
  }
}
