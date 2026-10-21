import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from '@earendil-works/pi-ai'
import { AGENT_MASK_PROPOSAL_TOOL } from './mask-proposal'

/**
 * 框选范围那一次调用交给快档（见 `thinking.config.json` 的 fast）。评测见
 * PR #1420：快档框得不如当前档准时保持关闭，只留代码与测试。
 */
export const FAST_REGION_ROUTING = false

let routing = FAST_REGION_ROUTING
export const fastRegionRouting = () => routing
/** 测试里打开或关上；不传就回到默认。 */
export function setFastRegionRoutingForTesting(enabled?: boolean): void {
  routing = enabled ?? FAST_REGION_ROUTING
}

export type RegionRaceWinner = 'fast' | 'main'

/**
 * 同一份上下文同时问快档和当前档。快档这一条是在发范围确认，就用它、掐掉当前档；
 * 否则（直接回答、改整图、出错）照常用当前档，它一直在跑，快档没有拖慢它。
 * 当前档的事件在被消费前排在它自己的流里，换谁都不丢。
 *
 * `onLoser` 拿到没被采用的那一条的终态消息，好给它记账。
 */
export async function raceRegionProposal(input: {
  readonly fast: (signal: AbortSignal) => Promise<AssistantMessageEventStream>
  readonly main: (signal: AbortSignal) => Promise<AssistantMessageEventStream>
  readonly signal?: AbortSignal
  readonly onLoser?: (loser: RegionRaceWinner, message: AssistantMessage) => Promise<void>
}): Promise<{ readonly winner: RegionRaceWinner; readonly stream: AssistantMessageEventStream }> {
  const fastAbort = new AbortController()
  const mainAbort = new AbortController()
  const forward = () => {
    fastAbort.abort()
    mainAbort.abort()
  }
  if (input.signal?.aborted) forward()
  else input.signal?.addEventListener('abort', forward, { once: true })
  const main = input.main(mainAbort.signal)
  // 先挂上，免得快档那边还没结束时它就以未处理的拒绝收场。
  main.catch(() => {})
  const events: AssistantMessageEvent[] = []
  let result: AssistantMessage | null = null
  try {
    const fast = await input.fast(fastAbort.signal)
    for await (const event of fast) events.push(event)
    result = await fast.result()
  } catch {
    result = null
  }
  if (result && proposesRegion(result) && !input.signal?.aborted) {
    mainAbort.abort()
    void main
      .then((stream) => stream.result())
      .then((message) => input.onLoser?.('main', message))
      .catch(() => {})
    const replay = createAssistantMessageEventStream()
    for (const event of events) replay.push(event)
    replay.end(result)
    return { winner: 'fast', stream: replay }
  }
  if (result) await input.onLoser?.('fast', result)
  return { winner: 'main', stream: await main }
}

/** 一条正常结束、只在发范围确认的助手消息。 */
export function proposesRegion(message: AssistantMessage): boolean {
  // 有的网关带着工具调用也报 stop；出错、截断、中止的都不算。
  if (message.stopReason !== 'toolUse' && message.stopReason !== 'stop') return false
  const calls = message.content.filter((block) => block.type === 'toolCall')
  return calls.length > 0 && calls.every((call) => call.name === AGENT_MASK_PROPOSAL_TOOL)
}
