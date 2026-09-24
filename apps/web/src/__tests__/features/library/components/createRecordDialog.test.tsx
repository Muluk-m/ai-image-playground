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
  useStore.setState({
    prompt: '',
    createTarget: 'generate',
    appMode: 'library',
    showToast: vi.fn(),
    setConfirmDialog: vi.fn(),
  })
  // jsdom 没有对象 URL，预览图拿不到地址就渲染不出来。
  URL.createObjectURL = ((file: File) => `blob:${file.name}`) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
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

/** 走「从本地选择」那个隐藏 input：文件夹选择器是另一个，按属性区开。 */
function pickImages(count: number): void {
  const input = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].find(
    (one) => !one.hasAttribute('webkitdirectory'),
  )
  if (!input) throw new Error('no file input')
  const files = Array.from(
    { length: count },
    (_, i) => new File(['x'], `图${i}.png`, { type: 'image/png' }),
  )
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
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

  it('素材一次进四张先问一声：没点确认前不进预览，确认了才收下', () => {
    act(() =>
      root.render(
        <CreateRecordDialog kind="asset" agentReady onClose={vi.fn()} onSave={vi.fn()} />,
      ),
    )
    pickImages(4)

    // 表单 portal 到 body，预览得在整份文档里数。取消（不执行 action）就停在这里：一张都没进来。
    expect(document.querySelectorAll('img')).toHaveLength(0)
    const confirm = vi.mocked(useStore.getState().setConfirmDialog).mock.calls[0]?.[0]
    act(() => confirm?.action())
    expect(document.querySelectorAll('img')).toHaveLength(4)
  })

  it('素材三张不打断，直接进预览', () => {
    act(() =>
      root.render(
        <CreateRecordDialog kind="asset" agentReady onClose={vi.fn()} onSave={vi.fn()} />,
      ),
    )
    pickImages(3)

    expect(useStore.getState().setConfirmDialog).not.toHaveBeenCalled()
    expect(document.querySelectorAll('img')).toHaveLength(3)
  })

  it('模板只认一张图：塞四张也只留第一张，且不该弹确认', () => {
    act(() =>
      root.render(<CreateRecordDialog kind="look" agentReady onClose={vi.fn()} onSave={vi.fn()} />),
    )
    pickImages(4)

    expect(useStore.getState().setConfirmDialog).not.toHaveBeenCalled()
    expect(document.querySelectorAll('img')).toHaveLength(1)
  })
})
