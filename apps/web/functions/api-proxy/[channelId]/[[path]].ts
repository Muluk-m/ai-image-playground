import { findChannel } from '../../_lib/channels'
import { handleProxyRequest } from '../../_lib/handler'

interface EventContext {
  request: Request
  env: Record<string, string | undefined>
  params: { channelId: string; path?: string | string[] }
}

export const onRequest = async (context: EventContext): Promise<Response> => {
  const { request, env, params } = context
  const channelId = params.channelId
  const pathSegments = Array.isArray(params.path) ? params.path : params.path ? [params.path] : []
  const path = pathSegments.join('/')

  return handleProxyRequest({
    request,
    channel: findChannel(channelId),
    path,
    env,
  })
}
