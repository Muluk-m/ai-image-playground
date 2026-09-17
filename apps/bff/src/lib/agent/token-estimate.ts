import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { estimateTokens } from '@earendil-works/pi-agent-core'
import type { ImageContent, TextContent } from '@earendil-works/pi-ai'

/**
 * 估一条消息值多少输入 token。纯模块：只依赖 pi 的类型与 `estimateTokens`，不读配置、不碰数据库——
 * 压缩那条路要能静态 import 它而不设任何 env。
 *
 * pi 的 `estimateTokens` 是「字符数 / 4」（图片块按固定 4800 字符），对英文大致成立，
 * 对中文系统性低估约 4 倍：主流分词器里一个汉字约占 1 个 token，而不是 0.25 个。
 * 本产品的系统提示词、工具说明与用户消息几乎全是中文，所以这里在 pi 的结果之上
 * 只补一项校正：`pi 的估算 + ceil(CJK 字符数 × (W − 0.25))`。
 *
 * 这样非 CJK 文本、图片块、toolCall 参数的口径完全沿用 pi，不另起炉灶；数 CJK 的文本范围
 * 与 pi 数字符的范围逐块对齐（见 `messageCjkChars`），不会漏块也不会多数。
 */

/**
 * 每个 CJK 字符折合多少 token。
 *
 * 校准依据（内部版线上实测的一个数据点）：输入「用一句话说你好」、空历史、无引用，
 * 上游报告的真实输入是 2268 token。下面这张表是**取这个读数当时**的字符/CJK 统计，
 * 是一份快照、不是当前值：此后系统提示词又长过（#522 加了创作类型说明并重写了澄清那段，
 * 现在是 1361 字符 / 1264 CJK / pi 341），技能清单进入常驻上下文也会再加一块。
 * 校准点没有随之重测，所以 W 仍是拿这份快照反解出来的那个值。本轮输入的三块当时是：
 *
 * | 部分                       | 字符 | CJK  | pi 估算 |
 * | -------------------------- | ---- | ---- | ------- |
 * | 系统提示词                 | 1286 | 1199 | 322     |
 * | 工具声明 JSON（无视频工具）| 2694 | 1006 | 674     |
 * | 工具声明 JSON（含视频工具）| 3460 | 1203 | 865     |
 * | 本轮 prompt                |    7 |    7 | 2       |
 *
 * pi 原口径合计 998（关视频）/ 1189（开视频），比真值低 56% / 48%。
 * 反解 W：关视频 (2268 − 1775×0.25) / 2212 ≈ 0.83；开视频 (2268 − 2344×0.25) / 2409 ≈ 0.70。
 * 真实请求还带着 chat template 与角色标记这些我们估不到的开销，所以真值只会比反解更低。
 *
 * 取 W = 0.8 时合计 2216（关视频，−2.3%）/ 2515（开视频，+10.9%），两种情况都在 ±15% 内；
 * 再往上取 0.85 会让开视频那一档到 +16%。上游是 OpenAI 兼容网关后的某个模型、分词器未知，
 * 这里只求同量级并略偏保守，不追求精确复刻。
 */
const CJK_TOKENS_PER_CHAR = 0.8

/**
 * pi 已经按 0.25 token/字符算过一遍，这里只补差额。按千分位的整数算：`0.8 - 0.25` 的二进制
 * 尾巴会让 `ceil(100 × 0.55)` 变成 56，整百字的中文段落凭空多一个 token。
 */
const CJK_CORRECTION_PER_MILLE = Math.round((CJK_TOKENS_PER_CHAR - 0.25) * 1000)

/**
 * 判为「一个字符约一个 token」的码位。覆盖中日韩统一表意文字与扩展、常用 CJK 标点
 * （、。「」《》和全角空格）、全角形式（，！？：；（）等，各自也约占一个 token）、
 * 假名与谚文；连带把部首、注音、带圈字母与兼容形式一起算进来，它们同样是宽字符。
 *
 * - U+1100–U+11FF   谚文字母
 * - U+2E80–U+2FDF   康熙部首及其补充
 * - U+3000–U+303F   CJK 符号和标点（全角空格、、。〈〉《》「」『』等）
 * - U+3040–U+30FF   平假名与片假名
 * - U+3100–U+312F   注音符号
 * - U+3130–U+318F   谚文兼容字母
 * - U+31A0–U+31BF   注音扩展
 * - U+31F0–U+31FF   片假名音标扩展
 * - U+3200–U+32FF   带圈 CJK 字母与月份
 * - U+3400–U+4DBF   CJK 统一表意文字扩展 A
 * - U+4E00–U+9FFF   CJK 统一表意文字
 * - U+A960–U+A97F   谚文字母扩展 B
 * - U+AC00–U+D7FF   谚文音节与谚文字母扩展 A/B
 * - U+F900–U+FAFF   CJK 兼容表意文字
 * - U+FE10–U+FE1F   竖排标点
 * - U+FE30–U+FE6F   CJK 兼容形式与小写变体形式
 * - U+FF00–U+FFEF   半角及全角形式（全角标点、全角拉丁字母、半角片假名）
 * - U+20000–U+3FFFF CJK 统一表意文字扩展 B 及以后
 *
 * 用 `u` 标志按码位匹配，所以扩展 B 那些代理对只算一个字符：pi 那边它按 `.length` 算两个
 * 字符（0.5 token），补上 0.55 后合计 1.05 token，方向仍然对。
 */
const CJK_PATTERN =
  /[\u1100-\u11ff\u2e80-\u2fdf\u3000-\u303f\u3040-\u30ff\u3100-\u312f\u3130-\u318f\u31a0-\u31bf\u31f0-\u31ff\u3200-\u32ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe10-\ufe1f\ufe30-\ufe6f\uff00-\uffef]|[\u{20000}-\u{3ffff}]/gu

function cjkChars(text: string): number {
  return text.match(CJK_PATTERN)?.length ?? 0
}

/** 与 pi 的同名私有函数一致：序列化不了的 toolCall 参数按它的占位字符串计。 */
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return '[unserializable]'
  }
}

/** 图片块在 pi 那边按固定 4800 字符折算，不含文字，所以这里不为它补任何 CJK。 */
function contentCjkChars(content: string | readonly (TextContent | ImageContent)[]): number {
  if (typeof content === 'string') return cjkChars(content)
  let chars = 0
  for (const block of content) {
    if (block.type === 'text' && block.text) chars += cjkChars(block.text)
  }
  return chars
}

/**
 * 逐 role 数 CJK，取的文本范围与 pi `estimateTokens` 数字符的范围一一对应
 * （pi-agent-core 0.85.1 `dist/harness/compaction/compaction.js:149-204`）：
 * 助手消息数 text / thinking / toolCall 的名称与参数，bash 数命令与输出，摘要消息数摘要正文。
 */
function messageCjkChars(message: AgentMessage): number {
  switch (message.role) {
    case 'user':
    case 'custom':
    case 'toolResult':
      return contentCjkChars(message.content)
    case 'assistant': {
      let chars = 0
      for (const block of message.content) {
        if (block.type === 'text') chars += cjkChars(block.text)
        else if (block.type === 'thinking') chars += cjkChars(block.thinking)
        else if (block.type === 'toolCall') {
          chars += cjkChars(block.name) + cjkChars(safeJsonStringify(block.arguments))
        }
      }
      return chars
    }
    case 'bashExecution':
      return cjkChars(message.command) + cjkChars(message.output)
    case 'branchSummary':
    case 'compactionSummary':
      return cjkChars(message.summary)
  }
  return 0
}

/**
 * 与 pi 的 `estimateTokens(message)` 同签名同单位，只是把 CJK 文本按真实分词量级折算。
 * 预扣估算与上下文压缩共用它，两处的「一条消息值多少 token」才不会各说各的。
 */
export function estimateMessageTokens(message: AgentMessage): number {
  return (
    estimateTokens(message) +
    Math.ceil((messageCjkChars(message) * CJK_CORRECTION_PER_MILLE) / 1000)
  )
}
