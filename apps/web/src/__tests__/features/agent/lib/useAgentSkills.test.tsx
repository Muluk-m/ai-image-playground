// @vitest-environment jsdom

import type { AgentMode, AgentSkillSummary } from '@image-playground/shared'
import { act, StrictMode } from 'react'
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

function Probe({ mode = 'image' }: { mode?: AgentMode }) {
  const names = useAgentSkills(mode).map((skill) => skill.name)
  seen.push(names)
  return <div>{names.join(',')}</div>
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
  it('并发挂载和 StrictMode 共用同模式请求，图片与视频分别加载', async () => {
    let resolveImage!: (skills: AgentSkillSummary[]) => void
    const image = new Promise<AgentSkillSummary[]>((resolve) => {
      resolveImage = resolve
    })
    fetchAgentSkills.mockImplementation((mode) => (mode === 'image' ? image : Promise.resolve([])))
    root = createRoot(host)
    await act(async () => {
      root.render(
        <StrictMode>
          <Probe />
          <Probe />
          <Probe />
          <Probe mode="video" />
        </StrictMode>,
      )
    })
    expect(fetchAgentSkills.mock.calls).toEqual([['image'], ['video']])
    await act(async () => {
      resolveImage([createLook])
    })
    expect(host.textContent).toBe('create-lookcreate-lookcreate-look')
  })

  it('失败的共享请求不会挡住下一次挂载重试', async () => {
    fetchAgentSkills.mockRejectedValueOnce(new Error('offline'))
    await mount()
    act(() => root.unmount())
    fetchAgentSkills.mockResolvedValueOnce([createLook])
    await mount()
    expect(fetchAgentSkills).toHaveBeenCalledTimes(2)
    expect(host.textContent).toBe('create-look')
  })

  it('请求完成后重新挂载仍会刷新自建模板目录', async () => {
    fetchAgentSkills.mockResolvedValueOnce([createLook])
    await mount()
    act(() => root.unmount())
    fetchAgentSkills.mockResolvedValueOnce([])
    await mount()
    expect(fetchAgentSkills).toHaveBeenCalledTimes(2)
    expect(host.textContent).toBe('')
  })

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
