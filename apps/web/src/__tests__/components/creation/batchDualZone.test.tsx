// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { BatchDualZone } from '../../../components/creation/BatchDualZone'
import { BatchExamplesPopover } from '../../../components/creation/BatchExamplesPopover'
import { TooltipProvider } from '../../../components/ui/tooltip'

const img = (id: string) => ({ id, dataUrl: `data:image/png;base64,${id}` })

describe('BatchDualZone', () => {
  it('renders loop and shared zones with symmetric @ triggers and supports cross-zone actions', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const onInsertCurrent = vi.fn()
    const onInsertShared = vi.fn()
    const onPromote = vi.fn()
    const onDemote = vi.fn()

    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      act(() =>
        root.render(
          <TooltipProvider>
            <BatchDualZone
              loopImages={[img('l1'), img('l2')]}
              sharedImages={[img('s1')]}
              mergeLimit={16}
              oversizedLoopIndexes={[]}
              oversizedSharedIndexes={[]}
              failedLoopIndexes={[]}
              failedSharedIndexes={[]}
              onAddLoop={vi.fn()}
              onAddShared={vi.fn()}
              onRemoveLoop={vi.fn()}
              onRemoveShared={vi.fn()}
              onClearLoop={vi.fn()}
              onClearShared={vi.fn()}
              onInsertCurrentMention={onInsertCurrent}
              onInsertSharedMention={onInsertShared}
              onPromoteLoopToShared={onPromote}
              onDemoteSharedToLoop={onDemote}
              onPreviewImage={vi.fn()}
            />
          </TooltipProvider>,
        ),
      )

      const loopPane = host.querySelector('[data-testid="batch-zone-loop"]')!
      const sharedPane = host.querySelector('[data-testid="batch-zone-shared"]')!
      expect(loopPane.textContent).toContain('遍历原图')
      expect(loopPane.textContent).toContain('2/50')
      expect(sharedPane.textContent).toContain('共用参考')
      expect(sharedPane.textContent).toContain('1/15')

      const currentBtn = [...loopPane.querySelectorAll('button')].find(
        (b) => b.textContent === '@当前图',
      )!
      act(() => currentBtn.click())
      expect(onInsertCurrent).toHaveBeenCalledTimes(1)

      const sharedRefBtn = [...sharedPane.querySelectorAll('button')].find(
        (b) => b.textContent === '@参考1',
      )!
      act(() => sharedRefBtn.click())
      expect(onInsertShared).toHaveBeenCalledWith(0)

      // 点击左区缩略图上的「@引用」自动提升到共用参考并插入引用
      const promoteBtn = loopPane.querySelector<HTMLButtonElement>(
        '[aria-label="引用第 2 张遍历原图并转为共用参考"]',
      )!
      act(() => promoteBtn.click())
      expect(onPromote).toHaveBeenCalledWith(1, true)

      // 模拟跨区拖拽：左区第 0 张拖入右区
      const loopThumb = loopPane.querySelector<HTMLElement>('[data-batch-loop-index="0"]')!
      const dataTransfer = {
        effectAllowed: 'move',
        dropEffect: 'move',
        types: [],
        files: [],
        setData: vi.fn(),
        getData: vi.fn(() => JSON.stringify({ zone: 'loop', index: 0 })),
      }
      act(() => {
        loopThumb.dispatchEvent(
          Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer }),
        )
        sharedPane.dispatchEvent(
          Object.assign(new Event('dragover', { bubbles: true, cancelable: true }), {
            dataTransfer,
          }),
        )
        sharedPane.dispatchEvent(
          Object.assign(new Event('drop', { bubbles: true, cancelable: true }), { dataTransfer }),
        )
      })
      expect(onPromote).toHaveBeenCalledWith(0, false)

      // 模拟跨区拖拽：右区第 0 张拖回左区
      const sharedThumb = sharedPane.querySelector<HTMLElement>('[data-batch-shared-index="0"]')!
      const reverseTransfer = {
        ...dataTransfer,
        getData: vi.fn(() => JSON.stringify({ zone: 'shared', index: 0 })),
      }
      act(() => {
        sharedThumb.dispatchEvent(
          Object.assign(new Event('dragstart', { bubbles: true }), {
            dataTransfer: reverseTransfer,
          }),
        )
        loopPane.dispatchEvent(
          Object.assign(new Event('dragover', { bubbles: true, cancelable: true }), {
            dataTransfer: reverseTransfer,
          }),
        )
        loopPane.dispatchEvent(
          Object.assign(new Event('drop', { bubbles: true, cancelable: true }), {
            dataTransfer: reverseTransfer,
          }),
        )
      })
      expect(onDemote).toHaveBeenCalledWith(0)
    } finally {
      act(() => root.unmount())
      host.remove()
      vi.unstubAllGlobals()
    }
  })
})

describe('BatchExamplesPopover', () => {
  it('shows live task breakdown when images exist and fills example prompt from gallery', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const onApplyPrompt = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      act(() =>
        root.render(
          <BatchExamplesPopover
            loopImages={[img('l1'), img('l2')]}
            sharedImages={[img('s1')]}
            mergeLimit={16}
            totalCredits={20}
            onApplyPrompt={onApplyPrompt}
          />,
        ),
      )

      const trigger = host.querySelector<HTMLButtonElement>('button')!
      expect(trigger.textContent).toContain('查看示例')
      act(() => trigger.click())

      // 有图时默认打开「当前拆解」页签
      expect(document.body.textContent).toContain('将发出 2 条独立任务')
      expect(document.body.textContent).toContain('2/16')

      // 切到「使用示例」并点「填入提示词」
      const galleryTab = [...document.body.querySelectorAll('button')].find(
        (b) => b.textContent === '使用示例',
      )!
      act(() => galleryTab.click())

      const fillBtn = [...document.body.querySelectorAll('button')].find(
        (b) => b.textContent === '填入提示词',
      )!
      act(() => fillBtn.click())
      expect(onApplyPrompt).toHaveBeenCalledTimes(1)
      expect(onApplyPrompt.mock.calls[0]?.[0]).toContain('@图1')
    } finally {
      act(() => root.unmount())
      host.remove()
      vi.unstubAllGlobals()
    }
  })
})
