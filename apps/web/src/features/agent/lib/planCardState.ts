import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentPromptConfirmResult } from '../store'

export type AgentPromptConfirmFailure = Extract<AgentPromptConfirmResult, { ok: false }>

/** 逐张确认停在某张稿上的原因：只存事实，文案在渲染时翻译。 */
export type PlanStop =
  | { kind: 'empty' }
  | { kind: 'failed'; failure: AgentPromptConfirmFailure; confirmed: number; title: string }

/**
 * 计划卡的全部交互状态，按稿的消息 id 记，由面板保管、按会话隔离。
 *
 * 计划卡是从消息列表现算出来的：逐张提交、别处确认、前后段消失都会让卡片换 key 重挂，
 * 卡片自己的 state 跟着丢——还在跑的确认循环把「被拒」写进已卸下的组件，用户什么也看不见。
 * 状态挂在稿 id 上，卡片怎么拆、怎么重挂都读得回来。
 */
export type PlanCardState = {
  /** 用户取消勾选的稿。 */
  skipped: ReadonlySet<string>
  /** 正在逐张确认、尚未成交的稿。 */
  busy: ReadonlySet<string>
  /** 停下的那张稿与原因。 */
  stops: ReadonlyMap<string, PlanStop>
  /** 用户按了「取消」的计划里的稿：计划还在拟、后面再追加稿换 key 重挂时，卡片仍是收起的。 */
  dismissed: ReadonlySet<string>
  /** 展开编辑的那张稿。 */
  open: string | null
}

export type PlanCardControl = PlanCardState & {
  skip: (id: string, skip: boolean) => void
  /**
   * 开始一次「全部生成」：把 ids 标为确认中，并清掉整段计划（planIds）上旧的停因。
   * 上次停下的那张被取消勾选、没在这次里，它的停因也要清，否则卡上仍指着上次那张。
   */
  begin: (ids: readonly string[], planIds: readonly string[]) => void
  /** 这些稿不再确认中（成交、被拒或循环结束）。 */
  release: (ids: readonly string[]) => void
  stop: (id: string, stop: PlanStop) => void
  /** 收起（取消）或恢复整段计划：ids 是这段计划此刻的全部稿。 */
  dismiss: (ids: readonly string[], dismissed: boolean) => void
  setOpen: (id: string | null) => void
}

type Stored = PlanCardState & { conversationId: string | null }

const empty = (conversationId: string | null): Stored => ({
  conversationId,
  skipped: new Set(),
  busy: new Set(),
  stops: new Map(),
  dismissed: new Set(),
  open: null,
})

const withoutIds = <T>(set: ReadonlySet<T>, ids: readonly T[]) => {
  if (!ids.some((id) => set.has(id))) return set
  const next = new Set(set)
  for (const id of ids) next.delete(id)
  return next
}

/** 换了会话就清空；只留仍是待确认稿的 id。没有可删的就原样返回。 */
function prune(
  stored: Stored,
  conversationId: string | null,
  liveIds: ReadonlySet<string>,
): Stored {
  if (stored.conversationId !== conversationId) return empty(conversationId)
  const dead = (id: string) => !liveIds.has(id)
  if (
    ![...stored.skipped, ...stored.busy, ...stored.stops.keys(), ...stored.dismissed].some(dead) &&
    !(stored.open !== null && dead(stored.open))
  )
    return stored
  return {
    conversationId,
    dismissed: new Set([...stored.dismissed].filter((id) => !dead(id))),
    open: stored.open !== null && dead(stored.open) ? null : stored.open,
    skipped: new Set([...stored.skipped].filter((id) => !dead(id))),
    busy: new Set([...stored.busy].filter((id) => !dead(id))),
    stops: new Map([...stored.stops].filter(([id]) => !dead(id))),
  }
}

/**
 * 面板级计划卡状态。换会话即清空，旧会话里还在跑的确认循环写不进新会话；
 * 只保留当前还是待确认稿的 id，消息被移除或成交后对应状态随即丢弃，id 复用不会串到新稿。
 */
export function usePlanCardState(
  conversationId: string | null,
  liveIds: ReadonlySet<string>,
): PlanCardControl {
  const [stored, setStored] = useState<Stored>(() => empty(conversationId))
  // 当前会话。确认循环拿的是发起时那一版的 control：会话已换，就不再写。
  const current = useRef(conversationId)
  current.current = conversationId
  const update = useCallback(
    (owner: string | null, change: (state: Stored) => Stored) =>
      setStored((state) => {
        if (owner !== current.current) return state
        return change(state.conversationId === owner ? state : empty(owner))
      }),
    [],
  )
  const state = useMemo(
    () => prune(stored, conversationId, liveIds),
    [stored, conversationId, liveIds],
  )
  // 读的时候已经按在场的稿过滤；这里再把过滤结果落回去，集合不随历史消息越积越大。
  useEffect(() => {
    if (state !== stored) setStored((latest) => prune(latest, conversationId, liveIds))
  }, [state, stored, conversationId, liveIds])

  return {
    ...state,
    skip: (id, skip) =>
      update(conversationId, (state) => {
        if (state.skipped.has(id) === skip) return state
        const skipped = new Set(state.skipped)
        if (skip) skipped.add(id)
        else skipped.delete(id)
        return { ...state, skipped }
      }),
    begin: (ids, planIds) =>
      update(conversationId, (state) => {
        const stops = new Map(state.stops)
        for (const id of [...planIds, ...ids]) stops.delete(id)
        return { ...state, stops, busy: new Set([...state.busy, ...ids]) }
      }),
    release: (ids) =>
      update(conversationId, (state) => {
        const busy = withoutIds(state.busy, ids)
        return busy === state.busy ? state : { ...state, busy }
      }),
    stop: (id, stop) =>
      update(conversationId, (state) => ({
        ...state,
        stops: new Map(state.stops).set(id, stop),
      })),
    dismiss: (ids, dismissed) =>
      update(conversationId, (state) => {
        if (!dismissed) {
          const next = withoutIds(state.dismissed, ids)
          return next === state.dismissed ? state : { ...state, dismissed: next }
        }
        if (ids.every((id) => state.dismissed.has(id))) return state
        return { ...state, dismissed: new Set([...state.dismissed, ...ids]) }
      }),
    setOpen: (id) =>
      update(conversationId, (state) => (state.open === id ? state : { ...state, open: id })),
  }
}
