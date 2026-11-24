import type {
  AgentMessageQueuedBody,
  AgentQueuedMessageView,
  AgentTurnEvent,
} from '@image-playground/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AgentConversationState,
  AgentRequestError,
  type AgentTurnOutcome,
  type AgentTurnSource,
} from '../../../../features/agent/lib/agentClient'
import type { TurnArtifactDelivery } from '../../../../features/agent/lib/artifactDelivery'
import {
  failPatch,
  reduceTurnEvent,
  type TurnEventState,
} from '../../../../features/agent/lib/turnEvents'
import {
  createTurnFollower,
  type TurnFollowerClient,
} from '../../../../features/agent/lib/turnFollower'
import { i18next } from '../../../../i18n'

const CONV = 'conv-1'

type State = TurnEventState & {
  conversationId: string | null
  queue: AgentQueuedMessageView[]
}

const turnStart = (turnId: string): AgentTurnEvent => ({
  type: 'turnStart',
  turnId,
  userMessageId: `u-${turnId}`,
})

const turnEnd = (turnId: string): AgentTurnEvent => ({
  type: 'turnEnd',
  turnId,
  durationMs: 10,
  stopReason: 'completed',
  usage: null,
})

const queued = (id: string, failure?: string): AgentQueuedMessageView => ({
  id,
  clientMessageId: `c-${id}`,
  text: '再来一张',
  referenceCount: 0,
  createdAt: 1,
  ...(failure ? { failure: failure as never } : {}),
})

const receipt = (
  state: AgentMessageQueuedBody['state'],
  turnId?: string,
): AgentMessageQueuedBody => ({
  queued: queued('q-1'),
  state,
  ...(turnId ? { turnId } : {}),
})

const snapshot = (patch: Partial<AgentConversationState> = {}): AgentConversationState => ({
  messages: [],
  turns: [],
  activeTurn: null,
  ...patch,
})

/** 一段事件流：事件放完之后才报终局，与 `followTurn` 一样。 */
function stream(
  events: readonly AgentTurnEvent[],
  outcome: AgentTurnOutcome,
  options: { cursor?: number; lastError?: unknown } = {},
) {
  const result = {
    outcome: null as AgentTurnOutcome | null,
    lastError: options.lastError,
    cursor: options.cursor ?? 0,
    events: undefined as unknown as AsyncGenerator<AgentTurnEvent>,
  }
  result.events = (async function* () {
    for (const event of events) yield event
    result.outcome = outcome
  })()
  return result
}

function fakeDelivery(): TurnArtifactDelivery & { current: boolean } {
  const delivery = {
    current: true,
    isCurrent: () => delivery.current,
    canContinue: () => delivery.current,
    reserve: () => {},
    enqueue: () => {},
    failed: () => {},
    discard: () => {},
    handOff: () => delivery,
    adopt: () => {},
    settled: async () => {},
  }
  return delivery
}

function harness(initial: Partial<State> = {}) {
  let state: State = {
    conversationId: CONV,
    messages: [],
    turns: {},
    turn: 'running',
    stopping: false,
    reconnecting: false,
    activeTurn: null,
    toolStartedAt: {},
    error: null,
    errorDiagnostic: null,
    queue: [],
    ...initial,
  }
  const streams: ReturnType<typeof stream>[] = []
  const sources: AgentTurnSource[] = []
  const client = {
    followTurn: vi.fn((_conversationId: string, source: AgentTurnSource) => {
      sources.push(source)
      const next = streams.shift()
      if (!next) throw new Error('no scripted stream left')
      return next
    }),
    fetchMessages: vi.fn<TurnFollowerClient['fetchMessages']>(),
    fetchSubmissionReceipt: vi.fn<TurnFollowerClient['fetchSubmissionReceipt']>(),
    reconcileSubmission: vi.fn<TurnFollowerClient['reconcileSubmission']>(),
    pollFollowUps: vi.fn(async () => null),
  }
  const deps = {
    get: () => state,
    set: (patch: unknown) => {
      const next = typeof patch === 'function' ? patch(state) : patch
      state = { ...state, ...(next as Partial<State>) }
    },
    apply: vi.fn(
      (
        event: AgentTurnEvent,
        pendingUserText: string | null,
        turnId: string,
        delivery: TurnArtifactDelivery,
        conversationId: string,
      ) => {
        if (delivery.isCurrent())
          deps.set(reduceTurnEvent(state, event, { turnId, pendingUserText, conversationId }))
      },
    ),
    fail: vi.fn((message?: string) => deps.set(failPatch(state, message))),
    adoptSnapshot: vi.fn(
      (_conversationId: string, taken: AgentConversationState, options?: { join?: string }) => {
        deps.set({
          queue: [...(taken.queue ?? [])],
          ...(options?.join ? { turn: 'running', activeTurn: { turnId: options.join } } : {}),
        })
      },
    ),
    openConversation: vi.fn(async () => {}),
    claimStageRunOrigins: vi.fn(),
    beginTurn: () => fakeDelivery(),
    client: client as unknown as Partial<TurnFollowerClient>,
    delay: vi.fn(async () => {}),
  }
  const follower = createTurnFollower(deps as never)
  return {
    follower,
    deps,
    client,
    sources,
    streams,
    state: () => state,
  }
}

const submission = () => ({ clientMessageId: 'c-1', signal: new AbortController().signal })

describe('createTurnFollower: follow', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => {
    h = harness()
  })

  it('follows a turn to its end and returns to idle', async () => {
    h.streams.push(stream([turnStart('t1'), turnEnd('t1')], 'ended'))
    await h.follower.follow(CONV, { turnId: 't1' }, null, fakeDelivery())
    expect(h.state()).toMatchObject({ turn: 'idle', activeTurn: null, error: null })
    expect(h.deps.fail).not.toHaveBeenCalled()
  })

  it('fails with the rate-limit text when the server throttles the stream', async () => {
    h.streams.push(stream([turnStart('t1')], 'rateLimited'))
    await h.follower.follow(CONV, { turnId: 't1' }, null, fakeDelivery())
    expect(h.deps.fail).toHaveBeenCalledWith(
      i18next.t('error.rateLimited', { ns: 'agent' }),
      undefined,
    )
  })

  it('fails the turn and rethrows when reducing an event throws', async () => {
    h.streams.push(stream([turnStart('t1')], 'ended'))
    h.deps.apply.mockImplementationOnce(() => {
      throw new Error('reducer broke')
    })
    await expect(h.follower.follow(CONV, { turnId: 't1' }, null, fakeDelivery())).rejects.toThrow(
      'reducer broke',
    )
    expect(h.deps.fail).toHaveBeenCalled()
    expect(h.state().turn).toBe('failed')
  })
})

describe('createTurnFollower: the stream drops before turnStart (submission receipts)', () => {
  it('learns the turn id from a consumed receipt and keeps following it', async () => {
    const h = harness()
    h.streams.push(stream([], 'gone'), stream([turnEnd('t1')], 'ended'))
    h.client.fetchSubmissionReceipt.mockResolvedValueOnce(receipt('consumed', 't1'))
    await h.follower.follow(
      CONV,
      { frames: (async function* () {})() },
      '画只猫',
      fakeDelivery(),
      undefined,
      submission(),
    )
    expect(h.sources[1]).toEqual({ turnId: 't1' })
    expect(h.state()).toMatchObject({ turn: 'idle', reconnecting: false })
    expect(h.deps.fail).not.toHaveBeenCalled()
  })

  it('hands a still-queued message to openConversation instead of failing', async () => {
    const h = harness()
    h.streams.push(stream([], 'unreachable'))
    h.client.fetchSubmissionReceipt.mockResolvedValueOnce(receipt('pending', 't0'))
    await h.follower.follow(
      CONV,
      { frames: (async function* () {})() },
      '画只猫',
      fakeDelivery(),
      undefined,
      submission(),
    )
    expect(h.deps.openConversation).toHaveBeenCalledWith(CONV, 't0')
    expect(h.deps.fail).not.toHaveBeenCalled()
  })

  it('fails when the server says the message was never accepted', async () => {
    const h = harness()
    h.streams.push(stream([], 'gone'))
    h.client.fetchSubmissionReceipt.mockResolvedValueOnce(receipt('cancelled'))
    await h.follower.follow(
      CONV,
      { frames: (async function* () {})() },
      '画只猫',
      fakeDelivery(),
      undefined,
      submission(),
    )
    expect(h.deps.fail).toHaveBeenCalled()
    expect(h.deps.openConversation).not.toHaveBeenCalled()
  })

  it('confirms through reconcile after three empty receipts', async () => {
    const h = harness()
    h.streams.push(stream([], 'gone'), stream([turnEnd('t1')], 'ended'))
    h.client.fetchSubmissionReceipt.mockResolvedValue(null)
    h.client.reconcileSubmission.mockResolvedValueOnce(receipt('consumed', 't1'))
    await h.follower.follow(
      CONV,
      { frames: (async function* () {})() },
      '画只猫',
      fakeDelivery(),
      undefined,
      submission(),
    )
    expect(h.client.fetchSubmissionReceipt).toHaveBeenCalledTimes(3)
    expect(h.client.reconcileSubmission).toHaveBeenCalledTimes(1)
    expect(h.sources[1]).toEqual({ turnId: 't1' })
  })
})

describe('createTurnFollower: the stream gives up mid-turn (snapshot reconciliation)', () => {
  const running = { activeTurn: { turnId: 't1' } }

  it.each([
    ['completed', undefined],
    ['failed', 'agent_turn_interrupted'],
  ] as const)('settles a turn that ended as %s (%s) from the snapshot without failing', async (stopReason, error) => {
    const h = harness(running)
    h.streams.push(stream([], 'unreachable'))
    h.client.fetchMessages.mockResolvedValueOnce(
      snapshot({
        turns: [{ turnId: 't1', durationMs: 5, stopReason, ...(error ? { error } : {}) }],
      }),
    )
    await h.follower.follow(CONV, { turnId: 't1' }, null, fakeDelivery())
    expect(h.deps.adoptSnapshot).toHaveBeenCalledTimes(1)
    expect(h.state()).toMatchObject({ turn: 'idle', activeTurn: null, error: null })
    expect(h.deps.fail).not.toHaveBeenCalled()
  })

  it('fails when the snapshot has no record of the turn', async () => {
    const h = harness(running)
    h.streams.push(stream([], 'gone'))
    h.client.fetchMessages.mockResolvedValueOnce(snapshot())
    await h.follower.follow(CONV, { turnId: 't1' }, null, fakeDelivery())
    expect(h.deps.fail).toHaveBeenCalled()
  })

  it('joins the successor turn the server already started', async () => {
    const h = harness(running)
    h.streams.push(stream([], 'unreachable'), stream([turnEnd('t2')], 'ended'))
    h.client.fetchMessages.mockResolvedValueOnce(
      snapshot({
        turns: [{ turnId: 't1', durationMs: 5, stopReason: 'completed' }],
        activeTurn: { turnId: 't2' },
        cursor: 41,
      }),
    )
    await h.follower.follow(CONV, { turnId: 't1' }, null, fakeDelivery())
    await vi.waitFor(() => expect(h.sources).toHaveLength(2))
    expect(h.deps.adoptSnapshot).toHaveBeenCalledWith(CONV, expect.anything(), { join: 't2' })
    expect(h.sources[1]).toEqual({ turnId: 't2', cursor: 41 })
    await vi.waitFor(() => expect(h.state().turn).toBe('idle'))
  })

  it('keeps reconnecting from the stream cursor while the turn is still running', async () => {
    const h = harness(running)
    h.streams.push(stream([], 'unreachable', { cursor: 9 }), stream([turnEnd('t1')], 'ended'))
    h.client.fetchMessages.mockResolvedValueOnce(snapshot({ activeTurn: { turnId: 't1' } }))
    await h.follower.follow(CONV, { turnId: 't1' }, null, fakeDelivery())
    expect(h.deps.delay).toHaveBeenCalled()
    expect(h.sources[1]).toEqual({ turnId: 't1', cursor: 9 })
    expect(h.state().turn).toBe('idle')
  })

  it('stops quietly once another turn has taken over the panel', async () => {
    const h = harness({ activeTurn: { turnId: 'other' } })
    h.streams.push(stream([], 'gone'))
    await h.follower.follow(CONV, { turnId: 't1' }, null, fakeDelivery())
    expect(h.client.fetchMessages).not.toHaveBeenCalled()
    expect(h.deps.fail).not.toHaveBeenCalled()
  })
})

describe('createTurnFollower: picking up the next queued turn', () => {
  it('waits for the server to register the queued turn, then joins it', async () => {
    const h = harness({ queue: [queued('q-1')] })
    h.streams.push(
      stream([turnStart('t1'), turnEnd('t1')], 'ended'),
      stream([turnEnd('t2')], 'ended'),
    )
    h.client.fetchMessages
      .mockResolvedValueOnce(snapshot({ queue: [queued('q-1')] }))
      .mockResolvedValueOnce(snapshot({ activeTurn: { turnId: 't2' } }))
    await h.follower.follow(CONV, { turnId: 't1' }, null, fakeDelivery())
    await vi.waitFor(() => expect(h.sources).toHaveLength(2))
    expect(h.sources[1]).toEqual({ turnId: 't2' })
    expect(h.client.fetchMessages).toHaveBeenCalledTimes(2)
  })

  it('shows the snapshot queue and stops when only failed messages are left', async () => {
    const h = harness({ queue: [queued('q-1')] })
    h.streams.push(stream([turnStart('t1'), turnEnd('t1')], 'ended'))
    const left = [queued('q-1', 'insufficient_credits')]
    h.client.fetchMessages.mockResolvedValueOnce(snapshot({ queue: left }))
    await h.follower.follow(CONV, { turnId: 't1' }, null, fakeDelivery())
    await vi.waitFor(() => expect(h.state().queue).toEqual(left))
    expect(h.sources).toHaveLength(1)
  })

  it('picks up the successor of a message that started a turn while this one was ending', async () => {
    const h = harness()
    h.follower.expectSuccessor(CONV)
    h.streams.push(
      stream([turnStart('t1'), turnEnd('t1')], 'ended'),
      stream([turnEnd('t2')], 'ended'),
    )
    h.client.fetchMessages.mockResolvedValueOnce(snapshot({ activeTurn: { turnId: 't2' } }))
    await h.follower.follow(CONV, { turnId: 't1' }, null, fakeDelivery())
    await vi.waitFor(() => expect(h.sources).toHaveLength(2))
    expect(h.sources[1]).toEqual({ turnId: 't2' })
  })

  it('does not look for a successor when nothing is queued or expected', async () => {
    const h = harness()
    h.streams.push(stream([turnStart('t1'), turnEnd('t1')], 'ended'))
    await h.follower.follow(CONV, { turnId: 't1' }, null, fakeDelivery())
    expect(h.client.fetchMessages).not.toHaveBeenCalled()
  })
})

describe('createTurnFollower: recoverSubmissionReceipt', () => {
  it('rethrows a 4xx and clears the reconnecting banner', async () => {
    const h = harness()
    h.client.fetchSubmissionReceipt.mockRejectedValueOnce(new AgentRequestError(404, 'not_found'))
    await expect(
      h.follower.recoverSubmissionReceipt(CONV, 'c-1', () => true),
    ).rejects.toBeInstanceOf(AgentRequestError)
    expect(h.state().reconnecting).toBe(false)
  })

  it('retries a 5xx and returns the receipt once it shows up', async () => {
    const h = harness()
    h.client.fetchSubmissionReceipt
      .mockRejectedValueOnce(new AgentRequestError(503, 'unavailable'))
      .mockResolvedValueOnce(receipt('pending'))
    await expect(h.follower.recoverSubmissionReceipt(CONV, 'c-1', () => true)).resolves.toEqual(
      receipt('pending'),
    )
    expect(h.deps.delay).toHaveBeenCalled()
  })

  it('returns null when the submission is cancelled', async () => {
    const h = harness()
    const controller = new AbortController()
    h.client.fetchSubmissionReceipt.mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('aborted')
    })
    await expect(
      h.follower.recoverSubmissionReceipt(CONV, 'c-1', () => true, controller.signal),
    ).resolves.toBeNull()
  })
})
