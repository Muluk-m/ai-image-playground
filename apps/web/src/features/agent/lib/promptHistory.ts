import {
  AGENT_PROMPT_HISTORY_KEY,
  safeLocalStorage,
  scopedStorageName,
} from '../../../lib/authScope'

/** 只留最近这些条：再往前的翻不回来，也不值得一直占着 localStorage。 */
const LIMIT = 50

/** 由旧到新，最后一条是最近发出去的那句。存坏了就当没有历史，不拿它去挡输入。 */
export function agentPromptHistory(): readonly string[] {
  const raw = safeLocalStorage.getItem(scopedStorageName(AGENT_PROMPT_HISTORY_KEY))
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((one): one is string => typeof one === 'string')
  } catch {
    return []
  }
}

/**
 * 服务端收下之后才记一条：没发出去的那句还留在输入框里，不该也占一条历史。
 * 记的是草稿原文（`@图N` 哨兵与 `/技能` 都在里面），翻回来才是同一句话、同一批胶囊。
 */
export function rememberAgentPrompt(prompt: string): void {
  if (!prompt.trim()) return
  const history = agentPromptHistory()
  // 连着发同一句只留一条；中间隔了别的句子再发，两条都留。
  if (history[history.length - 1] === prompt) return
  safeLocalStorage.setItem(
    scopedStorageName(AGENT_PROMPT_HISTORY_KEY),
    JSON.stringify([...history, prompt].slice(-LIMIT)),
  )
}
