// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../hooks/useImageThumbnail', () => ({
  useImageThumbnail: () => ({ dataUrl: 'data:image/png;base64,thumb' }),
}))

import SuggestionMenu, { useSuggestionMenu } from '../../../../components/SuggestionMenu'
import {
  type AtMentionValue,
  buildAtMentionGroups,
  getAssetNamesByImageId,
  matchAssetsByName,
} from '../../../../features/library/lib/assetMentions'
import type { AssetRecord } from '../../../../features/library/types'
import {
  createMentionLabels,
  getPromptMentionParts,
  getSelectedImageMentionLabel,
} from '../../../../lib/promptImageMentions'
import type { InputImage } from '../../../../types'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function asset(partial: Partial<AssetRecord> & { id: string; name: string }): AssetRecord {
  return { imageId: 'image-a', createdAt: 0, lastUsedAt: 0, ...partial }
}

const inputImages: InputImage[] = [
  { id: 'image-a', dataUrl: 'data:image/png;base64,a' },
  { id: 'image-b', dataUrl: 'data:image/png;base64,b' },
]

describe('getAssetNamesByImageId', () => {
  it('takes the most recently used name when one image carries several', () => {
    const names = getAssetNamesByImageId([
      asset({ id: '1', name: '白底图', lastUsedAt: 1000 }),
      asset({ id: '2', name: '主图', lastUsedAt: 3000 }),
      asset({ id: '3', name: '场景图', imageId: 'image-b', lastUsedAt: 500 }),
    ])

    expect(names).toEqual({ 'image-a': '主图', 'image-b': '场景图' })
  })

  it('keeps the first record when two names share the same last use', () => {
    const names = getAssetNamesByImageId([
      asset({ id: '1', name: '白底图', lastUsedAt: 1000 }),
      asset({ id: '2', name: '主图', lastUsedAt: 1000 }),
    ])

    expect(names).toEqual({ 'image-a': '白底图' })
  })
})

describe('mention labels from assets', () => {
  it('shows the asset name for an image that has one, and 图 N for the rest', () => {
    const labels = createMentionLabels(
      inputImages,
      getAssetNamesByImageId([asset({ id: '1', name: '熊猫', imageId: 'image-b' })]),
    )
    const prompt = `${getSelectedImageMentionLabel(0)}和${getSelectedImageMentionLabel(1)}`

    expect(getPromptMentionParts(prompt, labels)).toEqual([
      { type: 'mention', text: '@图1', imageIndex: 0 },
      { type: 'text', text: '和' },
      { type: 'mention', text: '@熊猫', imageIndex: 1 },
    ])
  })
})

describe('matchAssetsByName', () => {
  const assets = [
    asset({ id: '1', name: '白底图', lastUsedAt: 1000 }),
    asset({ id: '2', name: '浴室场景图', lastUsedAt: 3000 }),
    asset({ id: '3', name: 'Panda', lastUsedAt: 2000 }),
  ]

  it('lists the most recently used first when the query is empty', () => {
    expect(matchAssetsByName(assets, '').map((a) => a.name)).toEqual([
      '浴室场景图',
      'Panda',
      '白底图',
    ])
  })

  it('matches any part of the name, case-insensitively', () => {
    expect(matchAssetsByName(assets, '场景').map((a) => a.name)).toEqual(['浴室场景图'])
    expect(matchAssetsByName(assets, 'pan').map((a) => a.name)).toEqual(['Panda'])
    expect(matchAssetsByName(assets, '不存在')).toEqual([])
  })
})

describe('@ 菜单的素材分组', () => {
  const menuImages: InputImage[] = [inputImages[0]]
  const menuAssets: AssetRecord[] = [
    asset({ id: 'asset-1', name: '熊猫', imageId: 'image-b', lastUsedAt: 2000 }),
    asset({ id: 'asset-2', name: '正义盟大殿', imageId: 'image-c', lastUsedAt: 1000 }),
  ]

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

  function Harness({
    query,
    assets = menuAssets,
    onSelect,
  }: {
    query: string
    assets?: AssetRecord[]
    onSelect: (v: AtMentionValue) => void
  }) {
    const groups = buildAtMentionGroups({ query, inputImages: menuImages, assets })
    const menu = useSuggestionMenu({ groups, onSelect, onClose: () => {} })
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
    return Array.from(host.querySelectorAll('[role="option"]')).map((el) => el.textContent?.trim())
  }

  function headings() {
    return Array.from(host.querySelectorAll('[role="listbox"] > div > div:first-child')).map((el) =>
      el.textContent?.trim(),
    )
  }

  function pressKey(key: string) {
    act(() => {
      host
        .querySelector('[data-testid="editor"]')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  }

  it('参考图与素材分两组列出', () => {
    act(() => root.render(<Harness query="" onSelect={() => {}} />))

    expect(headings()).toEqual(['本次参考图', '素材'])
    expect(optionLabels()).toEqual(['@图1', '熊猫', '正义盟大殿'])
  })

  it('按名称过滤后只剩素材组', () => {
    act(() => root.render(<Harness query="熊" onSelect={() => {}} />))

    expect(headings()).toEqual(['素材'])
    expect(optionLabels()).toEqual(['熊猫'])
  })

  it('方向键跨分组连续移动，回车选中素材', () => {
    const onSelect = vi.fn()
    act(() => root.render(<Harness query="" onSelect={onSelect} />))

    pressKey('ArrowDown')
    pressKey('Enter')

    expect(onSelect).toHaveBeenCalledWith({ type: 'asset', id: 'asset-1' })
  })

  it('一条素材都没有时素材组留一行提示', () => {
    act(() => root.render(<Harness query="" assets={[]} onSelect={() => {}} />))

    expect(headings()).toEqual(['本次参考图', '素材'])
    expect(optionLabels()).toEqual(['@图1'])
    expect(host.textContent).toContain('还没有素材，右键参考图可保存')
  })

  it('键盘导航跳过素材空态提示', () => {
    const onSelect = vi.fn()
    act(() => root.render(<Harness query="" assets={[]} onSelect={onSelect} />))

    pressKey('ArrowDown')
    pressKey('Enter')

    expect(onSelect).toHaveBeenCalledWith({ type: 'image', index: 0 })
  })

  it('素材被搜索过滤光时不冒空态提示', () => {
    act(() => root.render(<Harness query="不存在的名字" onSelect={() => {}} />))

    expect(host.textContent ?? '').not.toContain('还没有素材')
  })
})
