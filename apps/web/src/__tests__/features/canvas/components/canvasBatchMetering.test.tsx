// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import CanvasBatchConfirmDialog from '../../../../features/canvas/components/CanvasBatchConfirmDialog'

const state = vi.hoisted(() => ({ none: false, blocked: false }))
vi.mock('../../../../lib/privateOverlay', () => ({
  usePrivateSubmissionGuard: () => ({
    blocked: state.blocked,
    metering: state.none ? 'none' : 'credits',
    estimatedCredits: 200,
    disabledReason: state.blocked ? '账号暂不可用' : undefined,
  }),
}))

it('keeps confirmation scope and authorization while hiding only unmetered prices', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let confirmed = 0
  const render = async () =>
    act(async () =>
      root.render(
        <CanvasBatchConfirmDialog
          title="确认批量生成"
          note="选中的两张图"
          count={2}
          onConfirm={async () => {
            confirmed++
          }}
          onClose={() => {}}
        />,
      ),
    )
  const dialog = () => document.querySelector('[role="dialog"]')!
  const confirm = () =>
    [...dialog().querySelectorAll('button')].find((b) => b.textContent?.includes('确认生成'))!
  try {
    await render()
    expect(dialog().textContent).toContain('200')
    state.none = true
    await render()
    expect(dialog().textContent).not.toContain('200')
    expect(dialog().textContent).toContain('选中的两张图')
    expect(confirm().textContent).toContain('2')
    await act(async () => confirm().click())
    expect(confirmed).toBe(1)
    state.blocked = true
    await render()
    expect(confirm().disabled).toBe(true)
    expect(dialog().textContent).toContain('账号暂不可用')
    await act(async () => confirm().click())
    expect(confirmed).toBe(1)
  } finally {
    await act(async () => root.unmount())
    host.remove()
    state.none = false
    state.blocked = false
  }
})
