import { videoRateMultiplier } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import {
  agentModeOf,
  type ComposerChargeKind,
  type ComposerCreateTarget,
  composerChargeKind,
  creationModeOf,
} from '../../../components/creation/composerMode'
import { composerImageRate, preparedComposerImageRate } from '../../../lib/imageCharge'

const TARGETS: readonly ComposerCreateTarget[] = ['generate', 'chat', 'canvas', 'video']

const IMAGE_REQUEST = { size: '1024x1024', quality: 'medium' } as const

function quote(kind: ComposerChargeKind): number {
  if (kind === 'video') return videoRateMultiplier('doubao-seedance-2-0-mini-260615', '720p')
  if (kind === 'direct-image') return composerImageRate('gpt-image-2.5-flare', IMAGE_REQUEST, true)
  return preparedComposerImageRate('gpt-image-2.5-flare', IMAGE_REQUEST, true)
}

function chargeOf(
  agentMode: 'image' | 'video',
  createTarget: ComposerCreateTarget,
): ComposerChargeKind {
  if (agentMode === 'video') return 'video'
  if (createTarget === 'generate') return 'direct-image'
  return 'agent-image'
}

describe('作曲器模式枚举映射（旧 → 新）', () => {
  it('InputBar：createTarget × inline 的 CreationMode、协议模式和计价路径不变', () => {
    for (const createTarget of TARGETS) {
      for (const inline of [true, false] as const) {
        const toCanvas = inline && createTarget !== 'generate'
        const legacyCreation = toCanvas ? (createTarget === 'video' ? 'video' : 'agent') : 'image'
        const legacyAgent = legacyCreation === 'video' ? 'video' : 'image'
        const creation = creationModeOf(createTarget, { inline })
        const agent = agentModeOf(creation)
        expect(creation, `${createTarget} inline=${inline}`).toBe(legacyCreation)
        expect(agent, `protocol ${createTarget} inline=${inline}`).toBe(legacyAgent)
        expect(composerChargeKind(agent, createTarget)).toBe(chargeOf(legacyAgent, createTarget))
        expect(quote(composerChargeKind(agent, createTarget))).toBe(
          quote(chargeOf(legacyAgent, createTarget)),
        )
      }
    }
  })

  it('AgentComposer：createTarget × 制作模式 × 视频是否开放的协议模式和计价路径不变', () => {
    for (const createTarget of TARGETS) {
      const legacyCreation =
        createTarget === 'video' ? 'video' : createTarget === 'generate' ? 'image' : 'agent'
      expect(creationModeOf(createTarget)).toBe(legacyCreation)
      for (const productionMode of [true, false] as const) {
        for (const videoAvailable of [true, false] as const) {
          const legacyAgent =
            productionMode || (videoAvailable && legacyCreation === 'video') ? 'video' : 'image'
          const agent = agentModeOf(legacyCreation, {
            production: productionMode,
            videoAvailable,
          })
          expect(
            agent,
            `protocol ${createTarget} production=${productionMode} video=${videoAvailable}`,
          ).toBe(legacyAgent)
          expect(composerChargeKind(agent, createTarget)).toBe(chargeOf(legacyAgent, createTarget))
          expect(quote(composerChargeKind(agent, createTarget))).toBe(
            quote(chargeOf(legacyAgent, createTarget)),
          )
        }
      }
    }
  })

  it('三种计价路径都有正数报价', () => {
    expect(quote('video')).toBeGreaterThan(0)
    expect(quote('direct-image')).toBeGreaterThan(0)
    expect(quote('agent-image')).toBeGreaterThan(0)
  })
})
