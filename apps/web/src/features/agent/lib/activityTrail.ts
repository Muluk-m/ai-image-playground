import type { AgentToolErrorCode, AgentToolName } from '@image-playground/shared'
import type { AgentPanelMessage, AgentToolMessage } from '../types'

/**
 * 只读工具：跑完什么也不留下，面板上只该是一行「做过这一步」。
 *
 * 这里必须是白名单而不是「这条消息带没带产物」——生成类工具在跑的时候同样两手空空，
 * 凭数据分不出「不会有产物」和「产物还没到」，折错了会把一张正在跑的结果卡藏掉。
 * 认不出的新工具一律按「会有产物」处理：多一张卡只是噪音，少一张是丢东西。
 */
const READ_ONLY_TOOLS: Readonly<Record<AgentToolName, true | undefined>> = {
  readProduction: true,
  writeProduction: undefined,
  proposeProductionEdit: undefined,
  proposeProductionAssets: undefined,
  proposeStoryboard: undefined,
  viewImage: true,
  viewVideo: true,
  readConversationImages: true,
  readBatchAnalysis: true,
  readLibrary: true,
  readCanvas: true,
  createNodes: undefined,
  updateNodes: undefined,
  connectNodes: undefined,
  deleteNodes: undefined,
  arrangeNodes: undefined,
  runNodes: undefined,
  applyScriptPlan: undefined,
  importCanvasImage: undefined,
  runStoryboardFrames: undefined,
  loadSkill: true,
  planImageBatch: undefined,
  proposeBatchGeneration: undefined,
  proposeBatchAnalysis: undefined,
  generateImage: undefined,
  editImage: undefined,
  generateVideo: undefined,
  saveAsset: undefined,
  saveLook: undefined,
  arrangeTimeline: undefined,
  // 改画布对象改的是用户看得见的东西，得留一张卡说清楚改了什么，不能折成一行。
  editCanvasObject: undefined,
  // 整理同样改了位置和页签，结果卡要留着，用户才知道这一屏是谁排的。
  arrangeCanvas: undefined,
  // 搜索与抓网页只是读：来源链接挂在过程步上，不另起一张结果卡。
  webSearch: true,
  webFetch: true,
  // 取到的网图进了用户媒体、可能落画布，得留一张带缩略图的卡。
  fetchImage: undefined,
  fetchListingImages: undefined,
}

/**
 * 「过程步」：只读工具、而且这一次确实什么也没留下（没产物、没后台任务、没失败、没出路）。
 *
 * 它们本来与「出了一张图、能重试、失败了要给出路」的调用共用同一张结果卡，于是对话里
 * 堆出一摞只写着「看图：4 张」的空卡，把结论挤出屏幕。
 */
export function isProcessStep(message: AgentPanelMessage): message is AgentToolMessage {
  if (message.kind !== 'tool') return false
  if (!message.toolName || !READ_ONLY_TOOLS[message.toolName]) return false
  if (message.artifacts?.length) return false
  if (message.job || message.timeline || message.retryOf || message.delivery) return false
  // 保存卡片是一张要用户点的卡，折进一行就没人点得到了。
  if (message.saveCard) return false
  // 等确认的那一步要露出提示词草稿，不能折进一行。
  if (message.status === 'awaiting_confirmation') return false
  // 联网读取失败仍是过程步骤；错误和重新处理入口会在活动轨的行内显示。
  if (message.errorCode || message.status === 'failed')
    return message.toolName === 'webFetch' || message.toolName === 'webSearch'
  return true
}

export interface ActivityTrail {
  /** 这串过程步；渲染在第一步原来的位置。 */
  readonly steps: readonly AgentToolMessage[]
  /**
   * 这串已经翻篇了：里面每一步都跑完了，而且模型开始给结论、或者话题翻到了下一轮。
   *
   * 「还在跑的不收」这一条不能省。工具起跑与后续事件常常落在同一次 React 批处理里，
   * 只看「后面还有没有消息」的话，活动轨第一次渲染就已经是翻篇态，整段过程一帧都不会出现。
   */
  readonly spent: boolean
}
export interface PanelGrouping {
  /** 起始下标 → 从这里开始的一串过程步。 */
  readonly trails: ReadonlyMap<number, ActivityTrail>
  /** 被折进某一串里的下标，本体不再单独渲染。 */
  readonly absorbed: ReadonlySet<number>
}

/**
 * 智能体自己已经纠正的失败：参数没通过校验（或取网图被拒）之后，同一轮里同一个工具又成功跑了一次。
 * 这种失败没有提交、没有扣费，用户也无事可做；留着那张「这次的参数不成立」卡只会让人以为出错了，
 * 还可能去点「让智能体重新处理」（BUG-46）。生成类的失败（上游出错、超时等）不在此列，照常显示。
 */
const SELF_CORRECTED_CODES: ReadonlySet<AgentToolErrorCode> = new Set<AgentToolErrorCode>([
  'invalid_params',
  'source_unavailable',
])

function recoveredFailures(messages: readonly AgentPanelMessage[]): ReadonlySet<number> {
  const recovered = new Set<number>()
  const succeeded = new Set<string>()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.kind !== 'tool' || !message.toolName) continue
    const key = `${message.turnId}\u0000${message.toolName}`
    if (message.status === 'succeeded') succeeded.add(key)
    else if (
      message.status === 'failed' &&
      message.errorCode &&
      SELF_CORRECTED_CODES.has(message.errorCode) &&
      !message.job &&
      !message.artifacts?.length &&
      succeeded.has(key)
    )
      recovered.add(index)
  }
  return recovered
}

/** 把连续的过程步归成一串。非过程步原样保留在它自己的位置上；已自行纠正的失败不显示。 */
export function groupPanelMessages(messages: readonly AgentPanelMessage[]): PanelGrouping {
  const trails = new Map<number, ActivityTrail>()
  const recovered = recoveredFailures(messages)
  const absorbed = new Set<number>(recovered)
  let index = 0
  while (index < messages.length) {
    const message = messages[index]!
    if (recovered.has(index) || !isProcessStep(message)) {
      index += 1
      continue
    }
    const steps: AgentToolMessage[] = []
    const start = index
    while (index < messages.length) {
      const step = messages[index]
      if (recovered.has(index)) {
        index += 1
        continue
      }
      if (!step || !isProcessStep(step)) break
      steps.push(step)
      absorbed.add(index)
      index += 1
    }
    const settled = steps.every((one) => one.status !== 'running' && one.status !== 'submitted')
    const movedOn = messages
      .slice(index)
      .some(
        (one) => one.turnId !== message.turnId || (one.kind === 'text' && one.role === 'assistant'),
      )
    trails.set(start, {
      steps,
      // 有失败时保留活动轨，用户仍需看到原因和可用的处理入口。
      spent: settled && movedOn && !steps.some((one) => one.status === 'failed'),
    })
  }
  return { trails, absorbed }
}
