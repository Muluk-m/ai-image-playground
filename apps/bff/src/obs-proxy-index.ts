import { createObsProxy } from './ops/obs-proxy'

/** OpenObserve 只读代理的进程入口（compose 服务 `obs-proxy`，APP_ROLE=obs-proxy）。 */

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    console.error(
      JSON.stringify({ level: 'error', service: 'obs-proxy', event: 'config.missing', name }),
    )
    process.exit(1)
  }
  return value
}

const token = required('OBS_PROXY_TOKEN')
// 令牌就是全部的访问控制，太短等于没有。
if (token.length < 32) {
  console.error(
    JSON.stringify({ level: 'error', service: 'obs-proxy', event: 'config.weak_token' }),
  )
  process.exit(1)
}

const handle = createObsProxy({
  upstream: process.env.OBS_UPSTREAM_URL?.trim() || 'http://openobserve:5080',
  org: process.env.OBS_ORG?.trim() || 'default',
  token,
  username: required('OBS_ROOT_EMAIL'),
  password: required('OBS_ROOT_PASSWORD'),
})

const port = Number(process.env.PORT) || 5081
const server = Bun.serve({
  port,
  async fetch(request) {
    const startedAt = performance.now()
    const response = await handle(request)
    const path = new URL(request.url).pathname
    if (path !== '/healthz')
      // 只记路径和结果；查询语句里可能有用户 id，不进日志。
      console.log(
        JSON.stringify({
          level: response.status >= 500 ? 'error' : response.status >= 400 ? 'warn' : 'info',
          service: 'obs-proxy',
          event: 'obs_proxy.request',
          method: request.method,
          path,
          status: response.status,
          elapsed_ms: Math.round(performance.now() - startedAt),
        }),
      )
    return response
  },
})

console.log(
  JSON.stringify({ level: 'info', service: 'obs-proxy', event: 'listen', port: server.port }),
)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0))
  })
}
