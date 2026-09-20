/**
 * 输入框登记的「填一句话」入口。欢迎页、空对话里的示例建议不归输入框管，
 * 点一下只把文字递过来：换掉草稿里的话、聚焦，发不发由用户决定。
 * 登记的是当下挂着的那一个：有智能体时是 AgentComposer，没有时是画布的直接生成栏。
 */
type Fill = (text: string) => void

let fill: Fill | null = null

/** 登记当前挂着的输入框；返回注销函数，只注销自己登记的那一个。 */
export function setAgentComposerFill(next: Fill): () => void {
  fill = next
  return () => {
    if (fill === next) fill = null
  }
}

export function fillAgentComposer(text: string): boolean {
  if (!fill) return false
  fill(text)
  return true
}
