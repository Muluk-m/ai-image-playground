// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LogoutDialog from '../../components/LogoutDialog'

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

function render(onConfirm: (clearLocalData: boolean) => void): void {
  act(() => root.render(<LogoutDialog onCancel={() => {}} onConfirm={onConfirm} />))
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((it) => it.textContent === label)
  if (!found) throw new Error(`no button labelled ${label}`)
  return found
}

function checkbox(): HTMLInputElement {
  const found = document.querySelector<HTMLInputElement>('input[type="checkbox"]')
  if (!found) throw new Error('no checkbox')
  return found
}

function click(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('the logout dialog', () => {
  it('keeps the local data unless the box is ticked', () => {
    const onConfirm = vi.fn()
    render(onConfirm)

    expect(checkbox().checked).toBe(false)
    click(button('退出'))

    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('asks for the local data to go when the box is ticked', () => {
    const onConfirm = vi.fn()
    render(onConfirm)

    click(checkbox())
    click(button('退出'))

    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('offers clearing the local data', () => {
    render(vi.fn())

    expect(document.body.textContent).toContain('同时清除本机数据')
  })
})
