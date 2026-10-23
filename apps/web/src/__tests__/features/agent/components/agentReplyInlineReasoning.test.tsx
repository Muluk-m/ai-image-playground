// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import AgentReply from '../../../../features/agent/components/AgentReply'

let cleanup = () => {}
afterEach(() => cleanup())

async function render(text: string, streaming = false) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<AgentReply text={text} streaming={streaming} />))
  cleanup = () => {
    act(() => root.unmount())
    host.remove()
  }
  return host
}

it('hides a leading reasoning tag stored before the server split it', async () => {
  const host = await render('<thinking>Reading canvas</thinking>\n已开始出图。')
  expect(host.textContent).toContain('已开始出图。')
  expect(host.textContent).not.toContain('Reading canvas')
})

it('renders nothing for an old reply that was only reasoning', async () => {
  const host = await render('<thinking>Launching image generation node')
  expect(host.textContent).toBe('')
})

it('keeps tags that appear in the middle of the reply', async () => {
  const host = await render('好的。<think>这也是正文</think>后面还在')
  expect(host.textContent).toContain('后面还在')
  expect(host.textContent).toContain('这也是正文')
})
