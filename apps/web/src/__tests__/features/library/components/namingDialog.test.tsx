// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NamingDialog from '../../../../features/library/components/NamingDialog'

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
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

function renderDialog(onSave: (name: string) => void, defaultName?: string) {
  act(() =>
    root.render(
      <NamingDialog
        title="存为素材"
        placeholder="素材名"
        defaultName={defaultName}
        onCancel={() => {}}
        onSave={onSave}
      />,
    ),
  )
}

function input(): HTMLInputElement {
  const el = document.querySelector<HTMLInputElement>('input')
  if (!el) throw new Error('no input')
  return el
}

function typeName(value: string) {
  const el = input()
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function submit() {
  act(() => {
    document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }))
  })
}

describe('the naming dialog', () => {
  it('starts from the default name and saves it untouched', () => {
    const onSave = vi.fn()
    renderDialog(onSave, '白底图')

    expect(input().value).toBe('白底图')
    submit()

    expect(onSave).toHaveBeenCalledWith('白底图')
  })

  it('falls back to the default name when the field is cleared', () => {
    const onSave = vi.fn()
    renderDialog(onSave, '白底图')

    typeName('   ')
    submit()

    expect(onSave).toHaveBeenCalledWith('白底图')
  })

  it('saves nothing when there is neither a name nor a default', () => {
    const onSave = vi.fn()
    renderDialog(onSave)

    submit()

    expect(onSave).not.toHaveBeenCalled()
  })
})
