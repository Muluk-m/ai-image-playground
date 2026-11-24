import { Buffer } from 'node:buffer'
import { createAsyncTaskRunner } from '../fanout'
import { upstreamAuthHeader } from '../routes'
import { clientError, type UpstreamCallResult } from '../shared'
import { VIDEO_MIME, VIDEO_STYLE_SPECS } from '../video'
import type { UpstreamExecutionContext, UpstreamExecutor } from './types'

export const videoUpstreamExecutor: UpstreamExecutor = {
  id: 'video',
  matches({ params, route }) {
    return params.provider === 'openai-compat' && Boolean(VIDEO_STYLE_SPECS[route.style])
  },
  async execute(ctx: UpstreamExecutionContext): Promise<UpstreamCallResult> {
    const { params, route, request, session } = ctx
    const videoSpec = VIDEO_STYLE_SPECS[route.style]
    if (!videoSpec) throw new Error(`no video spec for ${route.style}`)
    const video = request.video
    if (!video) throw clientError('视频任务缺少视频参数')
    const mode = video.mode ?? 'generate'
    if (!videoSpec.modes.includes(mode)) throw clientError('该模型不支持续写和改视频')

    const authHeader = {
      ...upstreamAuthHeader(route.style, route.key),
      ...(route.organization ? { 'openai-organization': route.organization } : {}),
    }
    const runner = createAsyncTaskRunner(session, params, authHeader)
    const protocol = videoSpec.protocol({ base: route.baseUrl, model: params.model, mode })
    const headers = { 'content-type': 'application/json', ...authHeader }
    const [taskId] = await runner.collectTaskIds(protocol, 1, () => ({
      method: 'POST',
      headers,
      body: JSON.stringify(videoSpec.body(params.model, request, video, mode)),
    }))
    const { payload } = await runner.pollAsyncTask(protocol, taskId!)
    const outcome = videoSpec.result(route.baseUrl, payload, video)
    const duration_seconds = outcome.durationSeconds
    if (outcome.kind === 'public') {
      return { payload: { data: [{ url: outcome.url, mime: VIDEO_MIME, duration_seconds }] } }
    }

    const res = await session.performFetch(
      outcome.url,
      { method: 'GET', headers: authHeader },
      false,
    )
    if (!res.ok) await session.parseResponse(res)
    const bytes = Buffer.from(await res.arrayBuffer())
    return {
      payload: {
        data: [{ b64_json: bytes.toString('base64'), mime: VIDEO_MIME, duration_seconds }],
      },
    }
  },
}
