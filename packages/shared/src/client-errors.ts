/**
 * 浏览器把自己遇到的错误报给 BFF，运营后台按指纹聚合展示。
 *
 * 发送方有两个：index.html 内联的启动守卫（应用 bundle 可能根本没跑起来，所以它自己发），
 * 以及应用自身的全局监听。两边都用 `navigator.sendBeacon` + `text/plain`，免预检、页面关闭时也能送达。
 */
export const CLIENT_ERRORS_PATH = '/api/client-errors'

/**
 * - `boot`：启动守卫亮出「工作台暂时无法打开」时报一条，context 里带触发原因与此前缓冲的异常
 * - `error` / `rejection`：React 渲染出界面后的全局未捕获异常与未处理的 Promise
 * - `react`：React 根节点上未被边界接住的渲染异常（整棵树会被卸载，等于白屏）
 */
export const CLIENT_ERROR_KINDS = ['boot', 'error', 'rejection', 'react'] as const
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number]

/** 两端共用的上限：发送方先截，服务端再按同一份截一遍，不信任对方。 */
export const CLIENT_ERROR_LIMITS = {
  /** 一次请求最多几条，多出的丢弃。 */
  batch: 20,
  /** 整个请求体。 */
  bodyBytes: 64 * 1024,
  message: 1000,
  name: 200,
  stack: 8000,
  url: 1000,
  release: 64,
  userAgent: 512,
  /** context 序列化后的长度，超了整段丢弃。 */
  context: 16 * 1024,
} as const

export interface ClientErrorReport {
  kind: ClientErrorKind
  name?: string
  message: string
  stack?: string
  /** 出错页面的 origin + pathname + hash；query 可能带一次性凭据，发送方不带。 */
  url?: string
  /** 前端构建标识，取自 index.html 的 `aip-html-build`。 */
  release?: string
  context?: Record<string, unknown>
}

export interface ClientErrorBatch {
  /** 匿名设备 ID。beacon 带不了自定义头，只能放在请求体里。 */
  deviceId?: string
  errors: ClientErrorReport[]
}
