import type { ChannelMedia } from '../channel-discovery'
import type { AgentMaskProposal, AgentToolResultBlock } from './tools'
import {
  AGENT_CONVERSATION_TITLE_MAX_CHARS,
  type AgentMessageRole,
  type AgentTextBlock,
} from './turn-params'

/** 一次澄清提问。落在助手消息里，所以重新打开会话还能看见、还能作答。 */
export interface AgentClarificationBlock {
  readonly type: 'clarification'
  readonly question: string
  readonly options: readonly string[]
  /** 服务端签发的修改范围；有它时卡片换成蒙版确认，回答要带回确认后的蒙版。 */
  readonly maskProposal?: AgentMaskProposal
  /** 服务端核对图片组合的选项；普通模型澄清不能签发这份映射。 */
  readonly imageCombination?: {
    readonly targetImageId: string
    readonly referenceImageIds: readonly string[]
    /** 原调用的有序输入，保留每组都需要的固定参考；旧记录可由 target/reference 还原。 */
    readonly inputImageIds?: readonly string[]
  }
}

export type AgentContentBlock = AgentTextBlock | AgentToolResultBlock | AgentClarificationBlock

export interface AgentMessageView {
  readonly id: string
  readonly turnId: string
  readonly role: AgentMessageRole
  readonly content: readonly AgentContentBlock[]
  readonly createdAt: number
}

/** 摘要正文的固定分节。用户原话不在这里：那一节由压缩模块从原文逐字取，不经模型。 */
export interface AgentCompactionNarrative {
  readonly completed: string
  readonly inProgress: string
  readonly decisions: string
  readonly artifacts: string
}

/**
 * 折叠区里用户原话的存档。
 *
 * 以前每一轮都从原始消息重建这一节，于是每一轮都得把整段历史读进来——这正是历史查询没法
 * 收敛的根因。改成随摘要一起落库：原文可以不在这一份历史里，用户说过的话仍然逐字在。
 *
 * 装不下时永远是丢最旧的（逐字保留从最新一条往回收），所以被省略的必然是连续的一截前缀，
 * 一个计数加一个字数就说得清，存档因此有界。
 */
export interface AgentCompactionVerbatim {
  /** 最旧的几条只记条数，正文仍在用户自己的历史里。 */
  readonly omittedCount: number
  /** 那几条加起来大约多少字。让模型知道省掉的是一句还是一页。 */
  readonly omittedChars: number
  /** 逐字保留的那些，按时间顺序，从第 `omittedCount + 1` 条用户消息起。 */
  readonly kept: readonly string[]
}

/** 会话上的上下文压缩私有状态。服务端自用，不进任何下发前端的视图。 */
export interface AgentCompactionRecord {
  readonly summary: AgentCompactionNarrative | null
  readonly anchor: { readonly lastMessageId: string; readonly coveredCount: number } | null
  /**
   * 与 `summary` 同生共死。旧记录没有这一项，读到就当摘要作废重折一次——补不出来的东西
   * 不能假装有，凭空少掉用户原话比多折一次贵得多。
   */
  readonly verbatim: AgentCompactionVerbatim | null
  readonly failureCount: number
  readonly openedAt: number | null
}

export interface AgentConversationView {
  readonly id: string
  readonly title: string
  readonly createdAt: number
  readonly updatedAt: number
  /**
   * 仅列表接口给：这段对话最近一次生成的第一张输出图。没有云端项目的对话在客户端只有
   * 一条本地项目记录，画布又是空的，封面只能靠它。
   */
  readonly coverMediaId?: string
}

/** 一轮的消耗明细，单位是积分。 */
export interface AgentTurnCost {
  readonly chat: number
  readonly image: number
  readonly video: number
  /** 轮结算时已经归集的任务；轮后才确认的任务不在其中，展示时可逐笔追加。 */
  readonly includedTaskIds?: readonly string[]
  /** 对话免费时，按本轮原价计算的减免；null 表示老计价接缝无法提供金额。 */
  readonly chatWaived?: number | null
}

export function agentTurnCostTotal(cost: AgentTurnCost): number {
  return cost.chat + cost.image + cost.video
}

export function agentTextFromBlocks(blocks: readonly { readonly type: string }[]): string {
  return blocks
    .filter((block): block is AgentTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

export function agentMessageText(message: AgentMessageView): string {
  return agentTextFromBlocks(message.content)
}

/** 说给模型听的产物名词。工具的结果文字与回放共用，两处不一致模型就指不准同一件东西。 */
export const AGENT_ARTIFACT_NOUN: Record<ChannelMedia, string> = { image: '图片', video: '视频' }

/**
 * 工具结果回放给模型的形状：产物 id 让它下一轮还能指着同一件东西说话。
 *
 * 已提交与已完成的生成卡带上真正执行的那句提示词：它是用户在确认卡上最后定下的指令，可能与他
 * 更早的原话不一致（他改掉了模型自作主张的颜色、补了一句约束）。复核与后续几轮都要按这一句判断，
 * 所以它必须出现在回放里，而不只是留在卡面上。
 */
export function agentToolResultSummary(block: AgentToolResultBlock): string {
  // 重试是用户自己点的：模型据此知道那张失败的图已经补上（或又失败了），不必再提议重做。
  const title = block.retryOf ? `用户重试了「${block.title}」` : block.title
  if (block.canvasRun) {
    const proposal = block.canvasRun
    if (
      !proposal.authorizationId ||
      !Array.isArray(proposal.nodeNames) ||
      proposal.stage === undefined ||
      proposal.budgetCap === undefined
    )
      return `${title}：旧运行建议仅供查看，没有阶段授权执行凭证；如需运行，先读取当前画布并重新提出阶段授权。历史 autoRun 标记不授予执行权限。`
    const lookup = JSON.stringify({
      authorizationId: proposal.authorizationId,
      nodeIds: proposal.nodeIds,
    })
    const finalize = proposal.storyboard
      ? `首帧阶段：确认这条授权即把分镜表（${proposal.storyboard.shotCount} 镜，共 ${proposal.storyboard.totalSeconds} 秒）定稿；确认前镜头表被改过则授权失效，需要重新提案。`
      : ''
    const stance = proposal.direct
      ? '这一轮用户开了直接出图：授权已登记，原标签页会立即开跑，没有确认卡，也不等待撤销。不要说待确认。'
      : '此记录是当时待确认的提案。'
    return `${title}：阶段「${proposal.stage}」，范围 ${proposal.nodeNames.join('、')}，预算上限 ${proposal.budgetCap} 积分。${finalize}${stance}当前状态必须查询 runNodes(${lookup})；只有真实 taskIds 才能说「已提交」，读取真实结果后才能说「已完成」。查询参数中的 ID 仅供工具使用，对用户以节点名称说明。`
  }
  if (block.status === 'awaiting_confirmation')
    return `${title}：提示词待用户确认，尚未提交生成任务`
  const executed =
    block.job && block.prompt ? `；执行提示词（用户确认的那一份）：${block.prompt}` : ''
  if (block.status === 'failed')
    return `${title}：失败（${block.message ?? '未知原因'}）${executed}`
  if (block.status === 'submitted') return `${title}：已提交后台任务，结果尚未就绪${executed}`
  if (block.status === 'queued') return `${title}：排队等待重试，尚未提交`
  // 保存卡片：调用本身成功只说明卡片备好了。存没存下由用户那一下决定，翻历史时模型照这一位
  // 判断该不该接着往下说（催一句、还是开始试效果），而不是看见「完成」就当已经存进了素材库。
  if (block.saveCard)
    return block.saveCard.status === 'saved'
      ? `${title}：用户已保存，记录 id ${block.saveCard.recordId ?? '未知'}`
      : `${title}：卡片已经给到用户，他还没按下保存`
  if (block.canvasRead)
    return `${title}：已读取节点 ${block.canvasRead.map((node) => `${node.name}（${node.id}）`).join('、') || '无'}；需要正文时重新读取。`
  if (block.visualObservations?.length)
    return `${title}：完成；已观察结论：${block.visualObservations.map((entry) => `图片 ${entry.imageId}：${entry.observation}`).join('；')}。需要像素时用 viewImage 重读。`
  if (block.fetchedImages?.length)
    return `${title}：完成，${block.fetchedImages
      .map((image) => `图片 ${image.imageId}（来自 ${image.sourceUrl}）`)
      .join(', ')}`
  // 来源只回放网址：正文已经在那一轮的上下文里用过，下一轮要细节就再搜一次或再抓一次。
  if (block.sources?.length)
    return `${title}：完成，来源 ${block.sources.map((source) => source.url).join(', ')}`
  const listed = (block.artifacts ?? [])
    .map((artifact) => `${AGENT_ARTIFACT_NOUN[artifact.media]} ${artifact.artifactId}`)
    .join(', ')
  return `${title}：${listed ? `完成，${listed}` : '完成'}${executed}`
}

/** 澄清回放给模型的形状：用户的下一条消息就是他选的那一项。 */
export function agentClarificationSummary(block: AgentClarificationBlock): string {
  const proposal = block.maskProposal
  if (proposal)
    return `请用户确认修改范围：图片 ${proposal.imageId} 的「${proposal.target}」，${proposal.change}${
      proposal.keep.length ? `；不动：${proposal.keep.join('、')}` : ''
    }（按蒙版生成，模型 ${proposal.model.label}）`
  return `向用户提问：${block.question}（选项：${block.options.join(' / ')}）`
}

/** 折行压成一行再截断，省略号占最后一格。 */
export function agentTitleLine(text: string, maxChars: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= maxChars) return trimmed
  return `${trimmed.slice(0, maxChars - 1)}…`
}

/** 线性时间剥离 Markdown 链接与图片语法 `![alt](url)` / `[text](url)`，避免正则回溯。 */
function stripMarkdownLinks(text: string): string {
  let out = ''
  let cursor = 0
  let searchFrom = 0
  while (searchFrom < text.length) {
    const open = text.indexOf('[', searchFrom)
    if (open === -1) break
    const close = text.indexOf(']', open + 1)
    if (close === -1) break
    if (text[close + 1] !== '(') {
      searchFrom = close + 1
      continue
    }
    const end = text.indexOf(')', close + 2)
    if (end === -1) break
    const start = open > cursor && text[open - 1] === '!' ? open - 1 : open
    out += text.slice(cursor, start)
    out += text.slice(open + 1, close)
    cursor = end + 1
    searchFrom = cursor
  }
  return cursor === 0 ? text : out + text.slice(cursor)
}

/**
 * 去掉标题里的 Markdown 记号：首条消息常是整段剧本，`**场景：**`、`- ` 列表头、`---`
 * 分隔线原样进标题很难看。只做标题用的粗处理，不解析成 AST。
 */
export function stripTitleMarkdown(text: string): string {
  const linesStripped = text
    .split('\n')
    .map((line) =>
      /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)
        ? ''
        : line.replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, ''),
    )
    .join('\n')
  return stripMarkdownLinks(linesStripped).replace(/\*\*|__|~~|`/g, '')
}

/** 首轮消息即标题；会话不支持改名，所以这是标题的唯一来源。 */
export function agentConversationTitle(firstUserMessage: string): string {
  // 整条消息只有 `---` 这类记号时，去掉就空了，宁可原样用。
  const plain = stripTitleMarkdown(firstUserMessage).trim() || firstUserMessage
  return agentTitleLine(plain, AGENT_CONVERSATION_TITLE_MAX_CHARS)
}
