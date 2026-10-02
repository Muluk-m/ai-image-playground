import { useEffect, useRef } from 'react'
import { i18next } from '../../../i18n'
import { assetSlotToken, type PromptAssetSlotDeclaration } from '../../../lib/promptImageMentions'
import { useStore } from '../../../store'

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
  /** 填好后选中的那一段，按 `text` 里的下标算。 */
  readonly highlight?: TextRange
  /**
   * `text` 里哪几段是素材位：那一段就是位名。认得素材位的输入框把它换成空位胶囊，
   * 不认得的（画布直接生成栏）原样当一段文字。
   */
  readonly slots?: readonly ComposerFillSlot[]
}

export interface ComposerFillSlot extends PromptAssetSlotDeclaration, TextRange {}

export interface TextRange {
  readonly start: number
  readonly end: number
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
 * 存储形态，胶囊、发送与服务端展开都不必另认一种写法；素材位写成空位。`selection` 是示例词在
 * 可见文本里的位置：空位胶囊按位名计长，所以 `text` 的下标就是可见文本的下标。
 */
export function agentComposerFillPrompt(content: ComposerFill): {
  readonly prompt: string
  readonly selection: TextRange
} {
  const head = content.skill ? `/${content.skill} ` : ''
  let body = ''
  let at = 0
  for (const slot of [...(content.slots ?? [])].sort((a, b) => a.start - b.start)) {
    if (slot.start < at) continue
    body += content.text.slice(at, slot.start) + assetSlotToken(slot)
    at = slot.end
  }
  const prompt = head + body + content.text.slice(at)
  const { highlight } = content
  const selection = highlight
    ? { start: head.length + highlight.start, end: head.length + highlight.end }
    : { start: head.length + content.text.length, end: head.length + content.text.length }
  return { prompt, selection }
}

export interface ComposerFillTarget {
  /** 现在输入框里存的那一句。 */
  readonly read: () => string
  /** 把内容写进输入框，返回写进去的那一句（存储形态）。 */
  readonly write: (content: ComposerFill) => string
  /** 此刻接不了（例如草稿还在加载）：自己提示过就返回 true，这次填入作罢。 */
  readonly busy?: () => boolean
}

/**
 * 输入框登记自己为「填一句话」的目标。三处宿主共用同一条规矩：只换掉空草稿或上一条原样未动的
 * 建议，用户自己写的话一个字都不动，提示一声。宿主只管怎么读写自己的提示词。
 */
export function useComposerFillTarget(target: ComposerFillTarget, enabled = true): void {
  const targetRef = useRef(target)
  targetRef.current = target
  const suggestedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled) return
    return setAgentComposerFill((content) => {
      const { read, write, busy } = targetRef.current
      if (busy?.()) return
      const current = read()
      if (current.trim() !== '' && current !== suggestedRef.current) {
        useStore.getState().showToast(i18next.t('agent:suggestions.draftKeptToast'), 'info')
        return
      }
      suggestedRef.current = write(content)
    })
  }, [enabled])
}
