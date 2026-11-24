import { createObsProxy, OBS_PROXY_MAX_BODY_BYTES, shouldLogObsProxyRequest } from './ops/obs-proxy'

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
  // Bun 自己也把请求体挡在上限外；处理器里还会边读边数，覆盖分块上传。
  maxRequestBodySize: OBS_PROXY_MAX_BODY_BYTES,
  // 默认 10 秒空闲就断开，而查询最长等 60 秒（createObsProxy 的 timeoutMs）。单位秒，上限 255。
  idleTimeout: 90,
  async fetch(request) {
    const startedAt = performance.now()
    const response = await handle(request)
    const path = new URL(request.url).pathname
    const elapsedMs = Math.round(performance.now() - startedAt)
    if (shouldLogObsProxyRequest(path, response.status, elapsedMs))
      // 只记路径和结果；查询语句里可能有用户 id，不进日志。
      console.log(
        JSON.stringify({
          level: response.status >= 500 ? 'error' : response.status >= 400 ? 'warn' : 'info',
          // Collector 用 pino 的 time 和 msg 填时间与正文；没有 msg 时正文就是整行 JSON。
          time: new Date().toISOString(),
          msg: `${request.method} ${path} ${response.status}`,
          service: 'obs-proxy',
          event: 'obs_proxy.request',
          method: request.method,
          path,
          status: response.status,
          elapsed_ms: elapsedMs,
        }),
      )
    return response
  },
})

console.log(
  JSON.stringify({
    level: 'info',
    time: new Date().toISOString(),
    msg: 'obs proxy listening',
    service: 'obs-proxy',
    event: 'listen',
    port: server.port,
  }),
)

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0))
  })
}
