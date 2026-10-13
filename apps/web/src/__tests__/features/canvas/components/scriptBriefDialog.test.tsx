// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import ScriptBriefDialog from '../../../../features/canvas/components/ScriptBriefDialog'

it('fills a popular brief and keeps an automatic field in the confirmed script', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onConfirm = vi.fn()
  await act(async () => root.render(<ScriptBriefDialog onClose={vi.fn()} onConfirm={onConfirm} />))
  const control = (label: string) => {
    const row = [...document.querySelectorAll('label')].find((one) =>
      one.textContent?.includes(label),
    )
    return row?.querySelector('input, textarea') as HTMLInputElement | HTMLTextAreaElement
  }
  expect(control('题材').value).toBe('都市现实')
  const preset = [...document.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('山海学徒'),
  )!
  await act(async () => preset.click())
  expect(control('题材').value).toBe('玄幻修仙')
  expect(control('大纲').value).toContain('阿禾')
  const style = [...document.querySelectorAll('label')].find((one) =>
    one.textContent?.includes('画风'),
  )!
  await act(async () => style.querySelector('button')!.click())
  expect(control('画风').value).toBe('自动')
  await act(async () =>
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === '生成文本节点')!
      .click(),
  )
  expect(onConfirm).toHaveBeenCalledOnce()
  const brief = onConfirm.mock.calls[0]![0]
  expect(brief.title).toBe('山海学徒')
  expect(brief.style).toBe('自动')
  expect(brief.outline).toContain('阿禾')
  expect(brief.episode1).toContain('阿禾')
  await act(async () => root.unmount())
  host.remove()
})
