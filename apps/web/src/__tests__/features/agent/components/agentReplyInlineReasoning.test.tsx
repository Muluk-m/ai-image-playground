// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import AgentReply from '../../../../features/agent/components/AgentReply'

let cleanup = () => {}
afterEach(() => cleanup())

async function render(text: string, streaming = false, userText = '') {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () =>
    root.render(<AgentReply text={text} streaming={streaming} userText={userText} />),
  )
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

it('strips injected Gujarati and keeps kana and Greek letters', async () => {
  const host = await render('已提交。પરિણામ会显示。ポケモンを見る。α 通道')
  expect(host.textContent).toContain('已提交。会显示。ポケモンを見る。α 通道')
  expect(host.textContent).not.toContain('પ')
})

it('keeps a leaked script the user already wrote', async () => {
  const host = await render('按你写的 પરિણામ 来。', false, '这句里有 પરિણામ')
  expect(host.textContent).toContain('પરિણામ')
})

it('shows the fallback and hides copy when an injected reply cleans down to punctuation (BUG-80)', async () => {
  const host = await render('પરિણામ。', false, '把第二张改成夜景')
  expect(host.textContent).toContain('回复语言异常，请再试一次。')
  expect(host.textContent).not.toContain('પ')
  expect(host.querySelector('button')).toBeNull()
})

it('shows the English fallback and hides copy for an English user (BUG-81)', async () => {
  const host = await render('પરિણામ સારું છે.', false, 'Make the second image a night scene')
  expect(host.textContent).toContain('That reply came back in an unexpected language. Try again.')
  expect(host.textContent).not.toContain('回复语言异常')
  expect(host.textContent).not.toContain('પ')
  expect(host.querySelector('button')).toBeNull()
})

it('keeps tags that appear in the middle of the reply', async () => {
  const host = await render('好的。<think>这也是正文</think>后面还在')
  expect(host.textContent).toContain('后面还在')
  expect(host.textContent).toContain('这也是正文')
})
