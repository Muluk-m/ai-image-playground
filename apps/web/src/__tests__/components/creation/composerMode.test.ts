import { describe, expect, it } from 'vitest'
import {
  agentModeOf,
  type ComposerCreateTarget,
  creationModeOf,
} from '../../../components/creation/composerMode'

const TARGETS: readonly ComposerCreateTarget[] = ['generate', 'chat', 'canvas', 'video']

describe('作曲器模式枚举映射（旧 → 新）', () => {
  it('InputBar：createTarget × inline 的 CreationMode 与协议模式不变', () => {
    for (const createTarget of TARGETS) {
      for (const inline of [true, false] as const) {
        const toCanvas = inline && createTarget !== 'generate'
        const legacyCreation = toCanvas ? (createTarget === 'video' ? 'video' : 'agent') : 'image'
        const legacyAgent = legacyCreation === 'video' ? 'video' : 'image'
        const creation = creationModeOf(createTarget, { inline })
        expect(creation, `${createTarget} inline=${inline}`).toBe(legacyCreation)
        expect(agentModeOf(creation), `protocol ${createTarget} inline=${inline}`).toBe(legacyAgent)
      }
    }
  })

  it('AgentComposer：createTarget × 制作模式 × 视频是否开放的协议模式不变', () => {
    for (const createTarget of TARGETS) {
      const legacyCreation =
        createTarget === 'video' ? 'video' : createTarget === 'generate' ? 'image' : 'agent'
      expect(creationModeOf(createTarget)).toBe(legacyCreation)
      for (const productionMode of [true, false] as const) {
        for (const videoAvailable of [true, false] as const) {
          const legacyAgent =
            productionMode || (videoAvailable && legacyCreation === 'video') ? 'video' : 'image'
          expect(
            agentModeOf(legacyCreation, { production: productionMode, videoAvailable }),
            `protocol ${createTarget} production=${productionMode} video=${videoAvailable}`,
          ).toBe(legacyAgent)
        }
      }
    }
  })
})
