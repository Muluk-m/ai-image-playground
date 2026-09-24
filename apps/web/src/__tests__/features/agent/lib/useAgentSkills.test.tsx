// @vitest-environment jsdom

import type { AgentSkillSummary } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchAgentSkills = vi.hoisted(() => vi.fn<(mode: string) => Promise<AgentSkillSummary[]>>())

vi.mock('../../../../features/agent/lib/agentClient', () => ({ fetchAgentSkills }))

import {
  resetAgentSkillsCache,
  useAgentSkills,
} from '../../../../features/agent/lib/useAgentSkills'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const createLook = {
  name: 'create-look',
  title: '建模板',
  description: '',
  icon: 'wand',
  summary: '',
} as AgentSkillSummary

let host: HTMLDivElement
let root: Root
let seen: string[][]

function Probe() {
  seen.push(useAgentSkills('image').map((skill) => skill.name))
  return null
}

async function mount(): Promise<void> {
  root = createRoot(host)
  await act(async () => {
    root.render(<Probe />)
  })
}

beforeEach(() => {
  resetAgentSkillsCache()
  fetchAgentSkills.mockReset()
  host = document.createElement('div')
  seen = []
})

afterEach(() => {
  act(() => root.unmount())
})

describe('useAgentSkills', () => {
  it('新挂载的组件第一帧就用上次拿到的目录，不等请求回来', async () => {
    fetchAgentSkills.mockResolvedValue([createLook])
    await mount()
    act(() => root.unmount())

    seen = []
    fetchAgentSkills.mockReturnValue(new Promise(() => {}))
    await mount()

    expect(seen[0]).toEqual(['create-look'])
  })

  it('重拉失败时沿用上次的目录', async () => {
    fetchAgentSkills.mockResolvedValue([createLook])
    await mount()
    act(() => root.unmount())

    seen = []
    fetchAgentSkills.mockRejectedValue(new Error('offline'))
    await mount()

    expect(seen[seen.length - 1]).toEqual(['create-look'])
  })
})
