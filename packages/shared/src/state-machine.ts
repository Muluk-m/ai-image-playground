/**
 * 纯函数状态机。状态、事件、转移表是唯一来源；写入点用 `step` / `allows` / `target`，
 * 不引入 XState。非法转移抛 `IllegalTransitionError`，不写库。
 */

export class IllegalTransitionError extends Error {
  readonly code = 'illegal_transition' as const

  constructor(
    readonly machine: string,
    readonly from: string,
    readonly event: string,
  ) {
    super(`${machine}: ${from} + ${event} is illegal`)
    this.name = 'IllegalTransitionError'
  }
}

export interface StateMachine<S extends string, E extends string> {
  readonly id: string
  readonly states: readonly S[]
  readonly events: readonly E[]
  readonly transitions: { readonly [State in S]: { readonly [Event in E]?: S } }
  allows(from: S, event: E): boolean
  /** 合法则返回下一状态，否则抛错。 */
  step(from: S, event: E): S
  tryStep(from: S, event: E): S | undefined
  /**
   * 这个事件在所有有定义的边上指向同一个状态时，返回那个状态。
   * 写入点已经用 SQL 限定了来源状态、但来源不止一个时用它，避免在不知道具体来源时猜错下一状态。
   */
  target(event: E): S
}

export function defineMachine<
  const S extends readonly [string, ...string[]],
  const E extends readonly [string, ...string[]],
>(definition: {
  id: string
  states: S
  events: E
  transitions: {
    readonly [State in S[number]]: { readonly [Event in E[number]]?: S[number] }
  }
}): StateMachine<S[number], E[number]> {
  const { id, states, events, transitions } = definition
  const stateList = states as readonly S[number][]
  const eventList = events as readonly E[number][]
  const known = new Set<string>(stateList)
  for (const state of stateList) {
    const row = transitions[state]
    for (const event of eventList) {
      const next = row[event]
      if (next !== undefined && !known.has(next)) {
        throw new Error(`${id}: ${state} + ${event} -> ${String(next)} is not a state`)
      }
    }
  }

  const allows = (from: S[number], event: E[number]) => transitions[from][event] !== undefined
  const step = (from: S[number], event: E[number]): S[number] => {
    const next = transitions[from][event]
    if (next === undefined) throw new IllegalTransitionError(id, from, event)
    return next
  }
  const target = (event: E[number]): S[number] => {
    const found = new Set<S[number]>()
    for (const state of stateList) {
      const next = transitions[state][event]
      if (next !== undefined) found.add(next)
    }
    if (found.size !== 1) throw new IllegalTransitionError(id, '*', event)
    return [...found][0]!
  }

  return {
    id,
    states,
    events,
    transitions,
    allows,
    step,
    tryStep: (from, event) => transitions[from][event],
    target,
  }
}
