// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CreateRecordDialog from '../../../../features/library/components/CreateRecordDialog'
import { useStore } from '../../../../store'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  useStore.setState({ prompt: '', createTarget: 'generate', appMode: 'library' })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((one) =>
    one.textContent?.includes(text),
  )
  if (!found) throw new Error(`no button ${text}`)
  return found
}

describe('CreateRecordDialog', () => {
  it('「用智能体创建」把命令放进创作页输入框、目标切成画布，等用户自己发', () => {
    const onClose = vi.fn()
    act(() =>
      root.render(<CreateRecordDialog kind="look" agentReady onClose={onClose} onSave={vi.fn()} />),
    )
    act(() => button('用智能体创建模板').click())

    const state = useStore.getState()
    expect(state.prompt).toBe('/create-look ')
    expect(state.createTarget).toBe('canvas')
    expect(state.appMode).toBe('image')
  })

  it('没有图或没有名字时不能保存', () => {
    act(() =>
      root.render(
        <CreateRecordDialog kind="asset" agentReady onClose={vi.fn()} onSave={vi.fn()} />,
      ),
    )
    const save = document.querySelector<HTMLButtonElement>('button[type="submit"]')
    expect(save?.disabled).toBe(true)
  })
})
