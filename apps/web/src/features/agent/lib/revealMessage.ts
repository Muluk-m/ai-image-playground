/**
 * 把对话里的某条消息滚到视野中央并短暂高亮。
 * 一条工具消息可能被并进一组出图 / 计划卡：先找它自己的结果卡，再找它所在的那一组。
 */
const HIGHLIGHT_MS = 2000
const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

/** 对话页（非画布）当前可见的那一列；画布视图下返回 null。 */
export function agentChatViewRoot(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>('.studio-layout[data-project-view="chat"]')
}

export function findAgentMessageElement(
  messageId: string,
  root: ParentNode = document,
): HTMLElement | null {
  // 不拼选择器：消息 id 来自服务端，逐个比对 dataset 免去转义（也不依赖 CSS.escape）。
  const card = document.getElementById(`agent-tool-card-${messageId}`)
  if (card && (root === document || (root as Node).contains(card))) return card
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>('[data-agent-message-id], [data-agent-run-ids]'),
  )
  return (
    blocks.find((one) => one.dataset.agentMessageId === messageId) ??
    blocks.find((one) => one.dataset.agentRunIds?.split(' ').includes(messageId)) ??
    null
  )
}

/** 找到就滚过去并高亮，返回 true；对话里没有这条（比如还没加载到）返回 false。 */
export function revealAgentMessage(messageId: string, root: ParentNode = document): boolean {
  const target = findAgentMessageElement(messageId, root)
  if (!target) return false
  target.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  target.setAttribute('data-agent-located', 'true')
  const previous = timers.get(target)
  if (previous) clearTimeout(previous)
  timers.set(
    target,
    setTimeout(() => {
      target.removeAttribute('data-agent-located')
      timers.delete(target)
    }, HIGHLIGHT_MS),
  )
  return true
}
