// @vitest-environment jsdom
import { act, type ComponentProps, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import NodePorts, { SpawnContext } from '../../../../features/canvas/components/NodePorts'

vi.mock('@xyflow/react', () => ({
  useUpdateNodeInternals: () => () => {},
  Position: { Left: 'left', Right: 'right' },
  Handle: ({
    type: _type,
    position: _position,
    isConnectableStart: _isConnectableStart,
    ...props
  }: ComponentProps<'div'> & { type: string; position: string; isConnectableStart?: boolean }) =>
    createElement('div', props),
}))
it('follows inside a fixed hit area, accepts immediate clicks there, resets on exit, and suppresses drag clicks', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host),
    spawn = vi.fn()
  act(() =>
    root.render(
      <SpawnContext.Provider value={spawn}>
        <NodePorts nodeId="target" />
      </SpawnContext.Provider>,
    ),
  )
  const handle = host.querySelector<HTMLElement>('[aria-label="接到下一个节点"]')!
  expect(host.querySelector('[aria-label="接入上文"]')).toBeNull()
  expect(host.querySelectorAll('[role="button"]')).toHaveLength(1)
  const range = handle.querySelector<HTMLElement>('.studio-node-port-range')!
  const visual = range.firstElementChild as HTMLElement
  vi.spyOn(range, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    width: 64,
    height: 64,
    right: 64,
    bottom: 64,
    toJSON: () => ({}),
  })
  const pointer = (type: string, x: number, y: number) =>
    act(() => range.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })))
  pointer('pointermove', 48, 42)
  expect(visual.style.transform).toBe('translate(16px, 10px)')
  pointer('pointerdown', 48, 42)
  pointer('click', 48, 42)
  expect(spawn).toHaveBeenCalledWith('target', 'right')
  pointer('pointerout', 80, 80)
  expect(visual.style.transform).toBe('translate(0px, 0px)')
  spawn.mockClear()
  pointer('pointerdown', 20, 20)
  pointer('click', 60, 20)
  expect(spawn).not.toHaveBeenCalled()
  act(() => handle.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })))
  expect(spawn).toHaveBeenCalledWith('target', 'right')
  act(() => root.unmount())
  host.remove()
})
