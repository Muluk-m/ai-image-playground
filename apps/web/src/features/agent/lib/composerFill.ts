/**
 * 输入框登记的「填一句话」入口。欢迎页、空对话里的示例建议、首页的起手句不归输入框管，
 * 点一下只把内容递过来：换掉草稿里的话、聚焦，发不发由用户决定。
 * 登记的是当下挂着的那一个：首页是对话 / 画布档的 InputBar，项目里有智能体时是 AgentComposer，
 * 没有时是画布的直接生成栏。
 */

/**
 * 递过来的内容。起手句带着技能与示例词：技能由输入框按自己的方式变成胶囊（智能体输入框里就是
 * 开头的 `/技能名`），示例词在填好后自动选中，用户直接打字就覆盖掉它。
 */
export interface ComposerFill {
  readonly text: string
  /** 技能的 kebab-case 标识；缺席即一句普通的话。 */
  readonly skill?: string
  /** 填好后选中的那一段，必须出现在 `text` 里。 */
  readonly highlight?: string
}

type Fill = (content: ComposerFill) => void

let fill: Fill | null = null

/** 登记当前挂着的输入框；返回注销函数，只注销自己登记的那一个。 */
export function setAgentComposerFill(next: Fill): () => void {
  fill = next
  return () => {
    if (fill === next) fill = null
  }
}

export function fillAgentComposer(content: string | ComposerFill): boolean {
  if (!fill) return false
  fill(typeof content === 'string' ? { text: content } : content)
  return true
}

/**
 * 智能体输入框里存的那一句：技能写成开头的 `/技能名`，与用户自己从 `/` 菜单选出来的同一个
 * 存储形态，胶囊、发送与服务端展开都不必另认一种写法。`selection` 是示例词在这句话里的位置；
 * 这句话里没有引用胶囊，存储形态与可见文本的坐标重合。
 */
export function agentComposerFillPrompt(content: ComposerFill): {
  readonly prompt: string
  readonly selection: { readonly start: number; readonly end: number }
} {
  const head = content.skill ? `/${content.skill} ` : ''
  const prompt = head + content.text
  const at = content.highlight ? content.text.indexOf(content.highlight) : -1
  const selection =
    at >= 0
      ? { start: head.length + at, end: head.length + at + (content.highlight?.length ?? 0) }
      : { start: prompt.length, end: prompt.length }
  return { prompt, selection }
}
