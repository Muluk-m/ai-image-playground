import type { AgentBackgroundJobView } from '@image-playground/shared'
import { create } from 'zustand'
import { accountScope } from '../../../lib/authScope'
import type { AgentPanelMessage, AgentToolMessage } from '../types'
import { AgentRequestError, fetchJobs as requestJobs } from './agentClient'
import { agentJobUnsettled } from './jobProgress'

/**
 * 各个对话的后台生成此刻怎样了，给对话外的地方看（BUG-16）：侧栏那一行在转还是出完了，
 * 出完时弹一条「XX 对话 N 张图已生成 · 查看」。
 *
 * 面板只等开着的那个对话（`backgroundJobs`）。切走时还没出完的任务交到这里，由它低频地问
 * 服务端，出完了记一笔、弹提示；切回去时交还面板。开着的那个对话由面板 store 每次变化时报进来，
 * 用户人在首页、别的入口或别的标签页时，它出完同样弹提示。
 *
 * 只在本标签页里记：刷新之后不知道之前切走的对话还有任务（要靠服务端给账号级的在跑清单，另说）。
 */

/** 一个对话出完了的那一次。 */
export interface AgentJobCompletion {
  readonly conversationId: string
  /** 生成出来的图（一张卡可能出几张）。 */
  readonly images: number
  /** 生成出来的视频：提示里单独说「个视频」，不算进图里。 */
  readonly videos: number
  /** 没有完成的任务（失败；用户自己取消的不算）。 */
  readonly failed: number
  readonly at: number
}

export interface AgentConversationActivity {
  /** 还没出完的生成任务数。 */
  readonly running: number
  /** 最近一次出完、用户还没回去看过。 */
  readonly done?: AgentJobCompletion
}

interface JobActivityState {
  readonly activity: Readonly<Record<string, AgentConversationActivity>>
  /** 此刻弹着的那条完成提示。 */
  readonly notice: AgentJobCompletion | null
}

export const useAgentJobActivity = create<JobActivityState>(() => ({ activity: {}, notice: null }))

/** 切走的对话多久问一次。人不在那个对话里，晚几秒知道没关系。 */
const AWAY_POLL_MS = 5_000

interface Hooks {
  /** 用户此刻正看着这个对话（在对话/画布入口、标签页在前台、开着的就是它）。 */
  viewing(conversationId: string): boolean
  fetchJobs(conversationId: string): Promise<readonly AgentBackgroundJobView[]>
  pollIntervalMs: number
  /** 出完了新图：重新拉一次项目目录，侧栏缩略图马上换成封面，不用等刷新。 */
  refreshCovers(): void
}

const hooks: Hooks = {
  viewing: () => false,
  fetchJobs: requestJobs,
  pollIntervalMs: AWAY_POLL_MS,
  refreshCovers: () => {},
}

/** 面板 store 告诉这里怎样算「正看着」；测试也从这里换掉请求与节奏。 */
export function configureAgentJobActivity(next: Partial<Hooks>): void {
  Object.assign(hooks, next)
}

const patch = (conversationId: string, next: AgentConversationActivity | null) =>
  useAgentJobActivity.setState((state) => {
    const activity = { ...state.activity }
    if (next) activity[conversationId] = next
    else delete activity[conversationId]
    return { activity }
  })

const isVideoCard = (result: Pick<AgentToolMessage, 'toolName' | 'job' | 'video'>) =>
  result.toolName === 'generateVideo' || result.job?.media === 'video' || result.video != null

/** 一组已经结束的卡，算出生成了几张图、几个视频、几个没成。 */
function tally(
  results: readonly Pick<
    AgentToolMessage,
    'status' | 'errorCode' | 'artifacts' | 'toolName' | 'job' | 'video'
  >[],
): Pick<AgentJobCompletion, 'images' | 'videos' | 'failed'> {
  let images = 0
  let videos = 0
  let failed = 0
  for (const result of results) {
    if (result.status === 'succeeded') {
      const artifacts = result.artifacts ?? []
      if (artifacts.length === 0) {
        // 结果卡还没带上成品：按这张卡出的是什么记一份。
        if (isVideoCard(result)) videos += 1
        else images += 1
        continue
      }
      for (const artifact of artifacts) {
        if (artifact.media === 'video') videos += 1
        else images += 1
      }
    } else if (result.status === 'failed' && result.errorCode !== 'cancelled') failed += 1
  }
  return { images, videos, failed }
}

function complete(
  conversationId: string,
  counts: Pick<AgentJobCompletion, 'images' | 'videos' | 'failed'>,
) {
  // 全是用户自己取消的：没什么可看的，也不提示。
  if (counts.images === 0 && counts.videos === 0 && counts.failed === 0) {
    patch(conversationId, null)
    return
  }
  if (counts.images > 0 || counts.videos > 0) hooks.refreshCovers()
  if (hooks.viewing(conversationId)) {
    patch(conversationId, null)
    return
  }
  const done: AgentJobCompletion = { conversationId, ...counts, at: Date.now() }
  patch(conversationId, { running: 0, done })
  useAgentJobActivity.setState({ notice: done })
}

/** 切走之后还在等的对话：一份守候一个对话。 */
const away = new Map<string, { readonly ids: Set<string>; readonly token: object }>()

function watchAway(conversationId: string, ids: readonly string[]) {
  if (!ids.length || away.has(conversationId)) return
  const token = {}
  const entry = { ids: new Set(ids), token }
  away.set(conversationId, entry)
  const previous = useAgentJobActivity.getState().activity[conversationId]
  patch(conversationId, { ...previous, running: ids.length })
  const sameAccount = accountScope()
  const live = () => away.get(conversationId)?.token === token && sameAccount()
  const settled = new Map<string, AgentBackgroundJobView['result']>()
  void (async () => {
    while (live()) {
      await new Promise((resolve) => setTimeout(resolve, hooks.pollIntervalMs))
      if (!live()) return
      let jobs: readonly AgentBackgroundJobView[]
      try {
        jobs = await hooks.fetchJobs(conversationId)
      } catch (error) {
        // 对话已经删了（或不再属于这个账号）：不再等，侧栏的「在跑」也收掉；其它错误下次再问。
        if (error instanceof AgentRequestError && (error.status === 404 || error.status === 403)) {
          if (!live()) return
          away.delete(conversationId)
          patch(conversationId, null)
          return
        }
        continue
      }
      if (!live()) return
      // 切走期间出完的图把助手叫醒、又提交了新的一批：这些也算这个对话还没出完的，一起等。
      for (const job of jobs)
        if (job.result.status === 'submitted' || job.result.status === 'queued')
          entry.ids.add(job.messageId)
      for (const job of jobs)
        if (
          entry.ids.has(job.messageId) &&
          job.result.status !== 'submitted' &&
          job.result.status !== 'queued'
        )
          settled.set(job.messageId, job.result)
      const seen = new Set(jobs.map((job) => job.messageId))
      // 服务端已经不列的（会话删了、记录收掉）不再等。
      const running = [...entry.ids].filter((id) => seen.has(id) && !settled.has(id)).length
      if (running > 0) {
        const current = useAgentJobActivity.getState().activity[conversationId]
        if (current?.running !== running) patch(conversationId, { ...current, running })
        continue
      }
      away.delete(conversationId)
      complete(conversationId, tally([...settled.values()]))
      return
    }
    if (away.get(conversationId)?.token === token) away.delete(conversationId)
  })()
}

/** 记下这些的是哪个账号：换了账号，上一个账号的状态整份作废。 */
let scope = accountScope()

/** 面板正开着的那个对话、以及开着期间见过的还没出完的卡。 */
let panel: { conversationId: string; ids: Set<string> } | null = null

/**
 * 面板 store 每次变化报进来。开着的对话换了：上一个还没出完的交给后台守候，新开的这个由面板
 * 自己等，后台那份就停下。开着的对话里见过的任务都出完了，就算这个对话出完了一次。
 */
export function reportAgentPanel(
  conversationId: string | null,
  messages: readonly AgentPanelMessage[],
  previous?: {
    readonly conversationId: string | null
    readonly messages: readonly AgentPanelMessage[]
  },
): void {
  if (!scope()) {
    resetAgentJobActivity()
    previous = undefined
  }
  if (previous?.conversationId && previous.conversationId !== conversationId) {
    const left = previous.messages.filter(agentJobUnsettled).map((message) => message.id)
    const from = previous.conversationId
    panel = null
    if (left.length) watchAway(from, left)
    // 回来时历史还没拉到就又走了：后台那份还在等，「在跑」别收掉。
    else if (!away.has(from) && !useAgentJobActivity.getState().activity[from]?.done)
      patch(from, null)
  }
  if (!conversationId) {
    panel = null
    return
  }
  if (panel?.conversationId !== conversationId) {
    panel = { conversationId, ids: new Set() }
  }
  // 回到这个对话：历史拉到了，面板接着等，后台那份才停下；还没拉到（或拉失败）时后台继续守着。
  if (messages.length) away.delete(conversationId)
  const unsettled = messages.filter(agentJobUnsettled)
  for (const message of unsettled) panel.ids.add(message.id)
  const current = useAgentJobActivity.getState().activity[conversationId]
  if (unsettled.length) {
    if (current?.running !== unsettled.length || current.done)
      patch(conversationId, { running: unsettled.length })
    return
  }
  if (panel.ids.size) {
    const ids = panel.ids
    panel.ids = new Set()
    complete(
      conversationId,
      tally(
        messages.filter(
          (message): message is AgentToolMessage => message.kind === 'tool' && ids.has(message.id),
        ),
      ),
    )
    return
  }
  if (current && !current.done && !away.has(conversationId)) patch(conversationId, null)
  if (current?.done && hooks.viewing(conversationId)) markAgentConversationSeen(conversationId)
}

/** 用户回去看过了：侧栏那个点收掉，提示也收掉。 */
export function markAgentConversationSeen(conversationId: string): void {
  const current = useAgentJobActivity.getState().activity[conversationId]
  if (current?.done) patch(conversationId, current.running ? { running: current.running } : null)
  if (useAgentJobActivity.getState().notice?.conversationId === conversationId)
    dismissAgentJobNotice()
}

export function dismissAgentJobNotice(): void {
  useAgentJobActivity.setState({ notice: null })
}

/** 换账号、测试之间：全部清掉。 */
export function resetAgentJobActivity(): void {
  scope = accountScope()
  away.clear()
  panel = null
  useAgentJobActivity.setState({ activity: {}, notice: null })
}
