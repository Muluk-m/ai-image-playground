// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SuggestionMenu, { useSuggestionMenu } from '../../../../components/SuggestionMenu'
import {
  buildTemplateMenuGroups,
  getSlashTemplateQuery,
} from '../../../../features/library/lib/templates'
import type { TemplateRecord } from '../../../../features/library/types'

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

function makeTemplate(overrides: Partial<TemplateRecord>): TemplateRecord {
  return {
    id: 't1',
    name: '模板',
    prompt: '前缀',
    assetIds: [],
    params: { size: '1024x1024', quality: 'high', n: 1 },
    createdAt: 1,
    lastUsedAt: 1,
    ...overrides,
  }
}

const TEMPLATES = [
  makeTemplate({ id: 't1', name: '锁产品前缀', lastUsedAt: 2 }),
  makeTemplate({ id: 't2', name: '分镜风格后缀', lastUsedAt: 1 }),
]

/** 复刻 composer 的 `/` 接线：可见提示词 + 光标 → 候选 → 弹层。Esc 在 composer 里靠失焦收起。 */
function Harness({ prompt, onSelect }: { prompt: string; onSelect: (id: string) => void }) {
  const [blurred, setBlurred] = useState(false)
  const query = blurred ? null : getSlashTemplateQuery(prompt, prompt.length)
  const groups = query ? buildTemplateMenuGroups({ query: query.query, templates: TEMPLATES }) : []
  const menu = useSuggestionMenu({ groups, onSelect, onClose: () => setBlurred(true) })

  return (
    <div data-testid="editor" onKeyDown={menu.handleKeyDown}>
      {menu.visible && (
        <SuggestionMenu
          groups={groups}
          activeIndex={menu.activeIndex}
          offsetLeft={0}
          onActiveIndexChange={menu.setActiveIndex}
          onSelect={menu.select}
        />
      )}
    </div>
  )
}

function optionLabels() {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('[role="option"]')).map((button) =>
    button.textContent?.trim(),
  )
}

function pressKey(key: string) {
  const editor = host.querySelector<HTMLDivElement>('[data-testid="editor"]')
  if (!editor) throw new Error('harness not rendered')
  act(() => {
    editor.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

describe('the / menu in the composer', () => {
  it('lists every template, most recently used first', () => {
    act(() => root.render(<Harness prompt="/" onSelect={() => {}} />))

    expect(optionLabels()).toEqual(['锁产品前缀', '分镜风格后缀'])
  })

  it('filters by name', () => {
    act(() => root.render(<Harness prompt="/分镜" onSelect={() => {}} />))

    expect(optionLabels()).toEqual(['分镜风格后缀'])
  })

  it('applies the highlighted template on Enter', () => {
    const onSelect = vi.fn()
    act(() => root.render(<Harness prompt="/" onSelect={onSelect} />))

    pressKey('ArrowDown')
    pressKey('Enter')

    expect(onSelect).toHaveBeenCalledWith('t2')
  })

  it('closes on Escape', () => {
    act(() => root.render(<Harness prompt="/" onSelect={() => {}} />))

    pressKey('Escape')

    expect(optionLabels()).toEqual([])
  })

  it('stays shut inside path-like text', () => {
    act(() => root.render(<Harness prompt="src/lib" onSelect={() => {}} />))

    expect(optionLabels()).toEqual([])
  })
})
