import { SERVER_IDLE_TIMEOUT_SEC } from '@image-playground/shared'
import { websocket } from 'elysia/ws'
import type { app as application } from '../app'
import { withRequestContext } from './request-context'

/** Production and integration tests share the upgrade handler and request-context boundary. */
export function startHttpServer(
  app: typeof application,
  options: { port: number; hostname?: string },
) {
  app.compile()
  const server = Bun.serve({
    ...options,
    development: false,
    idleTimeout: SERVER_IDLE_TIMEOUT_SEC,
    // Match Cloudflare's ingress limit for direct-origin requests too.
    maxRequestBodySize: 100 * 1024 * 1024,
    // Elysia vendors an older Bun socket type; the native handler contract is unchanged.
    websocket: {
      ...app.config.websocket,
      ...websocket,
    } as unknown as Bun.WebSocketHandler<unknown>,
    fetch: withRequestContext((request) => app.fetch(request)),
  })
  app.server = server
  return server
}
