import { SafeFetchError } from '../../safeFetch'
import { AgentToolError } from './errors'

/**
 * 联网工具共用的这一条翻译：`safeFetch` 的失败 → 工具失败分类。
 *
 * 三个联网工具（搜索、抓网页、取网图）抓的都是模型写下的网址，失败的也都是同几种，
 * 所以分类写在一处。地址被拒、绕太多跳、对方 4xx/5xx、内容超限都是来源不可用，
 * 换个来源才有用；不能归成模型参数错误或可原样重试的生成服务错误。
 * 真正的网络故障与超时仍照原样归类。
 *
 * 消息保留 `safeFetch` 的具体原因，并告诉模型换来源。
 */
export function safeFetchToolError(error: unknown): Error {
  if (!(error instanceof SafeFetchError)) {
    // 不是抓取本身的错就原样交出去，中止最要紧：把 AbortError 翻成工具失败，会让这一轮
    // 把「用户按了停」记成「抓网页坏了」（分类见 `createToolFailureLog`）。
    return error instanceof Error ? error : new Error(String(error))
  }
  switch (error.code) {
    case 'timeout':
      return new AgentToolError('timeout', error.message)
    case 'network':
      return new AgentToolError('upstream_error', error.message)
    default:
      return new AgentToolError(
        'source_unavailable',
        `${error.message}。请换一个可公开访问的来源，不要原样重试这个地址。`,
      )
  }
}
