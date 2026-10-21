// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import InspirationCard from '../../../../features/inspiration/components/InspirationCard'
import InspirationDetail from '../../../../features/inspiration/components/InspirationDetail'
import { useInspirationStore } from '../../../../features/inspiration/store'
import type { InspirationItem } from '../../../../features/inspiration/types'

function item(category: string): InspirationItem {
  return {
    id: 'case',
    kind: 'showcase',
    title: '示例',
    prompt: 'prompt',
    thumbnailUrl: 'https://example.com/case.jpg',
    params: { size: '1024x1024' },
    recommendedModel: 'gpt-image-2.5-flare',
    recommendedProvider: 'openai-compat',
    category,
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  useInspirationStore.setState({
    items: [],
    detailItemId: null,
    detailFallback: null,
    selectedGroup: null,
    selectedCategory: null,
    searchKeyword: '',
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useInspirationStore.setState({ items: [], detailItemId: null, detailFallback: null })
})

it.each([
  ['人物与角色', '人物与头像'],
  ['UI 与界面', '品牌与界面'],
  ['图表与信息图', '信息图'],
  ['摄影与写实', '摄影与写实'],
])('卡片副标题显示合并分组 %s → %s', async (category, label) => {
  await act(async () =>
    root.render(<InspirationCard item={item(category)} pinned={false} onClick={() => {}} />),
  )
  expect(host.querySelector('.text-label-sm')?.textContent).toBe(`${label} · Image 2.5 Flare`)
})

it('详情分类标签显示合并分组', async () => {
  useInspirationStore.setState({
    items: [item('人物与角色')],
    detailItemId: 'case',
  })
  await act(async () => root.render(<InspirationDetail />))
  const badge = [...document.body.querySelectorAll('span')].find(
    (node) => node.textContent === '人物与头像',
  )
  expect(badge?.textContent).toBe('人物与头像')
  expect(document.body.textContent).not.toContain('人物与角色')
})
