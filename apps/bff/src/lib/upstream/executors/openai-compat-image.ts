import { FormData } from 'undici'
import { config } from '../../../config'
import { planDispatchedImage, stampReceipt } from '../adapters'
import { createAsyncTaskRunner, fanOutRequests } from '../fanout'
import { gptDirectConfigured } from '../gpt-routing'
import { isGrokImagine2, normalizeGrokEditInputs, normalizeGrokImagine2EditInputs } from '../grok'
import { isGptImageModel, mergeOpenAIDataResults, mergeOpenAIImageResults } from '../openai'
import { upstreamAuthHeader } from '../routes'
import type { UpstreamCallResult } from '../shared'
import type { UpstreamFetchInit } from '../types'
import { VIDEO_STYLE_SPECS } from '../video'
import type { UpstreamExecutionContext, UpstreamExecutor } from './types'

export const openaiCompatImageExecutor: UpstreamExecutor = {
  id: 'openai-compat-image',
  matches({ params, route }) {
    return params.provider === 'openai-compat' && !VIDEO_STYLE_SPECS[route.style]
  },
  async execute(ctx: UpstreamExecutionContext): Promise<UpstreamCallResult> {
    const { params, route, request, useNativeN, session } = ctx
    const { provider, model, resume } = params
    const {
      baseUrl: base,
      key,
      style,
      forceB64Json,
      supportsModeration,
      asyncTasks,
      supportsNativeN,
      imageSizes,
      gptRoute,
      organization,
    } = route

    const authHeader = {
      ...upstreamAuthHeader(style, key),
      ...(organization ? { 'openai-organization': organization } : {}),
    }
    const resumeIds = resume?.taskIds ?? []
    const useAsyncTasks = asyncTasks || resumeIds.length > 0

    // 参考图拼图要在计划之前做完：适配器的 plan 是同步的，接触表合成不是。
    let imageRequest = request
    if (
      style === 'grok-openai-images' &&
      (imageRequest.input_images?.length || imageRequest.mask)
    ) {
      imageRequest = isGrokImagine2(model)
        ? normalizeGrokImagine2EditInputs(imageRequest)
        : await normalizeGrokEditInputs(imageRequest, session.deadline.signal)
    }
    const useImageResponses =
      params.imageProtocol !== 'generations' &&
      !useNativeN &&
      style === 'openai-images' &&
      gptRoute !== 'direct' &&
      isGptImageModel(model) &&
      Boolean(config.upstream.imageResponsesModel) &&
      resumeIds.length === 0
    const dispatched = planDispatchedImage({
      provider,
      model,
      request: imageRequest,
      style,
      ...(gptRoute ? { gptRoute } : {}),
      supportsNativeN,
      supportsModeration,
      forceB64Json,
      ...(imageSizes ? { imageSizes } : {}),
      ...(config.upstream.imageResponsesModel
        ? { imageResponsesModel: config.upstream.imageResponsesModel }
        : {}),
      useImageResponses,
      member: params.gptMember === true,
      directOn: gptDirectConfigured(model),
    })
    if (!dispatched || dispatched.plan.calls.length === 0) {
      throw new Error(`no image adapter for ${style}`)
    }
    const firstCall = dispatched.plan.calls[0]!
    session.setImagesPerDispatch(dispatched.plan.calls.length === 1 ? firstCall.images : 1)
    const url = `${base}${firstCall.path}`
    const makeInit = (): UpstreamFetchInit => {
      const body = dispatched.plan.freshBody ? dispatched.plan.freshBody() : firstCall.body
      if (dispatched.adapter.protocol === 'openai-responses') {
        return {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            ...authHeader,
          },
          body: JSON.stringify(body),
        }
      }
      if (firstCall.multipart) {
        if (!(body instanceof FormData))
          throw new Error('multipart image call is missing form data')
        return { method: 'POST', headers: authHeader, body }
      }
      return {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeader },
        body: JSON.stringify(body),
      }
    }
    const merge =
      dispatched.adapter.protocol === 'agnes' ? mergeOpenAIDataResults : mergeOpenAIImageResults
    if (dispatched.adapter.protocol === 'openai-responses') {
      const result = await fanOutRequests(
        dispatched.plan.calls.length,
        async () => session.parseResponse(await session.performFetch(url, makeInit()), true),
        mergeOpenAIImageResults,
        params.reconciliationRequired,
        session.cancelled,
      )
      return stampReceipt(result, dispatched.plan)
    }
    const runner = createAsyncTaskRunner(session, params, authHeader)
    const result = await runner.dispatch(
      base,
      url,
      dispatched.plan.calls.length,
      useAsyncTasks,
      makeInit,
      merge,
    )
    return stampReceipt(result, dispatched.plan)
  },
}
