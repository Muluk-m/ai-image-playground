import type { Agent } from '@earendil-works/pi-agent-core'
import type { AgentTurnReference } from '@image-playground/shared'
import type { AgentImageSource, AgentInterjectOptions, TurnEventLog } from '../contracts'
import {
  archiveAgentReferences,
  removeAgentTurnReferences,
  resolveTurnReferences,
} from '../conversation'
import type { TurnMessageStore } from './turn-store'
import type {
  PreparedAgentTurn,
  SteeringReferenceEntry,
  TurnExecutionState,
  TurnRuntimePorts,
} from './turn-types'

export interface TurnInterjectionController {
  consumeSteeringReference(text: string): SteeringReferenceEntry | undefined
  hasUnconsumedSteering(): boolean
  interject(
    text: string,
    references?: readonly AgentTurnReference[],
    options?: AgentInterjectOptions,
  ): Promise<string | null>
}

/**
 * 负责单轮进行中的用户插话：校验并归档插话附图、协同直接落库或队列认领、注入 `agent.steer`。
 */
export function createTurnInterjectionController(input: {
  readonly prepared: PreparedAgentTurn
  readonly ports: TurnRuntimePorts
  readonly state: TurnExecutionState
  readonly images: AgentImageSource
  readonly store: TurnMessageStore
  readonly events: TurnEventLog
  readonly agent: Agent
}): TurnInterjectionController {
  const { prepared, ports, state, images, store, events, agent } = input
  const { conversationId, turnId, execution } = prepared
  const { audience, mode } = prepared.input
  const steeringReferences = new Map<string, SteeringReferenceEntry[]>()

  const isAccepting = () => state.acceptingInterjections && !state.aborted

  return {
    consumeSteeringReference(text) {
      const pending = steeringReferences.get(text)
      const steering = pending?.shift()
      if (pending?.length === 0) steeringReferences.delete(text)
      return steering
    },
    hasUnconsumedSteering: () => steeringReferences.size > 0,
    async interject(text, references = [], options = {}) {
      if (!isAccepting()) return null
      const evidence = await ports.turnInput.turnVisualEvidence(
        await resolveTurnReferences(references, conversationId, prepared.userId, !options.claim),
        'interjection',
      )
      if (!isAccepting()) return null
      await execution.assert()
      const messageId = options.messageId ?? crypto.randomUUID()
      const archiveId = `${turnId}/interjections/${messageId}${options.claim ? '' : `/${crypto.randomUUID()}`}`
      const stored = await archiveAgentReferences(conversationId, archiveId, references)
      // 上传期间本轮可能已结束；拒收并只清理本次上传，不能误删首轮或其它插话的引用。
      const reject = async () => {
        if (stored.length) await removeAgentTurnReferences(conversationId, archiveId)
        return null
      }
      if (!isAccepting()) return reject()
      // 排队消息升级来的插话到这一刻才从收件箱取走：之前的几秒里它仍然排着，停止与撤回拿得到它。
      if (options.claim && !(await options.claim())) return reject()
      // 取走之后到这里之间本轮可能刚好收尾：交由调用方放回收件箱。
      if (!isAccepting()) return reject()
      if (!options.claim) {
        let outcome: 'accepted' | 'duplicate' | 'rejected'
        try {
          outcome = await store.admitDirectInterjection({
            messageId,
            text,
            references,
            stored,
            isAccepting,
          })
        } catch (error) {
          await reject()
          throw error
        }
        if (outcome === 'rejected') return reject()
        if (outcome === 'duplicate') {
          await reject()
          return messageId
        }
      }
      const active = references.length ? references : images.references
      const steered = ports.turnInput.turnModelPrompt(
        ports.turnInput.turnPromptText(
          ports.turnInput.expandSkillInvocation(text, mode, audience),
          active,
          references.length > 0,
        ),
        evidence,
      )
      const pending = steeringReferences.get(steered.text) ?? []
      // 授权原文仍是用户打的那句：`/skill-name` 展开出来的是给模型看的指引，不是他的许可。
      pending.push({ references, text, active })
      steeringReferences.set(steered.text, pending)
      if (options.claim)
        store.enqueueClaimedInterjection({ id: messageId, text, references: stored })
      events.emit({ type: 'interjection', messageId, text })
      if (options.claim) await execution.assert()
      agent.steer({
        role: 'user',
        content: [{ type: 'text', text: steered.text }, ...steered.content],
        timestamp: Date.now(),
      })
      return messageId
    },
  }
}
