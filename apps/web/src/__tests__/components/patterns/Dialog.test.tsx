// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Dialog from '../../../components/patterns/Dialog'
import { Button } from '../../../components/ui/button'

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

describe('Dialog', () => {
  it('names the dialog after its title and closes from the header button', () => {
    const onClose = vi.fn()
    act(() =>
      root.render(
        <Dialog title="导入链接" onClose={onClose} footer={<Button>确认</Button>}>
          <p>正文</p>
        </Dialog>,
      ),
    )
    const dialog = document.body.querySelector('[role="dialog"]')
    const heading = dialog?.querySelector('h2')
    expect(heading?.textContent).toBe('导入链接')
    expect(dialog?.getAttribute('aria-labelledby')).toBe(heading?.id)
    expect(dialog?.textContent).toContain('正文')
    expect(dialog?.textContent).toContain('确认')

    const close = dialog?.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')
    act(() => close?.click())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('leaves out the footer bar when there is no footer', () => {
    act(() =>
      root.render(
        <Dialog title="说明" onClose={() => {}}>
          <p>正文</p>
        </Dialog>,
      ),
    )
    expect(document.body.querySelector('[data-slot="dialog-footer"]')).toBeNull()
  })
})
