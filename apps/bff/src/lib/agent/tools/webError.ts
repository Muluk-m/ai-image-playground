import { SafeFetchError } from '../../safeFetch'
import { AgentToolError } from './errors'

/**
 * 联网工具共用的这一条翻译：`safeFetch` 的失败 → 工具失败分类。
 *
 * 三个联网工具（搜索、抓网页、取网图）抓的都是模型写下的网址，失败的也都是同几种，
 * 所以分类写在一处。地址被拒、绕太多跳、对方 4xx/5xx、内容超限，**都是模型换个网址就能
 * 自救的事**，一律归 `invalid_params`——它们不是我们的上游出了毛病，报成 `upstream_error`
 * 会让界面给出「重试」这条对模型没用的出路。真正的网络故障与超时才照原样归类。
 *
 * 消息原样沿用 `safeFetch` 写的那一句：它本来就是写给模型读的中文。
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
      return new AgentToolError('invalid_params', error.message)
  }
}
