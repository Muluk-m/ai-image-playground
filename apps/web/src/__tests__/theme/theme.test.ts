// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTheme,
  getThemeChoice,
  initTheme,
  resolveTheme,
  setThemeChoice,
  subscribeTheme,
  THEME_STORAGE_KEY,
} from '../../theme'
import { THEME_BOOT_SCRIPT, THEME_COLORS } from '../../theme/bootScript'
import { themeBootPlugin } from '../../theme/vitePlugin'

/** 一个能手动翻转的假 matchMedia：jsdom 没有，而「跟随系统」的全部行为都挂在它上面。 */
function stubSystem(initialDark: boolean) {
  let dark = initialDark
  const listeners = new Set<(event: { matches: boolean }) => void>()
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return dark
      },
      addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
        listeners.add(listener),
      removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
        listeners.delete(listener),
    })),
  )
  return {
    set(next: boolean) {
      dark = next
      for (const listener of listeners) listener({ matches: next })
    },
  }
}

function themeColor(): string | null {
  return document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null
}

let dispose: (() => void) | undefined

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
  // 真实页面里首帧脚本排在 head 最前面，那一刻还没有任何 meta，所以这里也从空的 head 起步。
  document.head.innerHTML = ''
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.unstubAllGlobals()
})

describe('resolveTheme', () => {
  it.each([
    [null, false, 'light'],
    [null, true, 'dark'],
    ['system', false, 'light'],
    ['system', true, 'dark'],
    ['light', true, 'light'],
    ['light', false, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['garbage', true, 'dark'],
    ['garbage', false, 'light'],
  ] as const)('已保存 %s、系统偏暗 %s → %s', (stored, systemDark, expected) => {
    expect(resolveTheme(stored, systemDark)).toBe(expected)
  })
})

describe('没选过：跟随系统', () => {
  it('启动时取系统明暗，系统变了跟着变', () => {
    const system = stubSystem(false)
    dispose = initTheme()

    expect(getThemeChoice()).toBe('system')
    expect(getTheme()).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(themeColor()).toBe(THEME_COLORS.light)

    system.set(true)

    expect(getTheme()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(themeColor()).toBe(THEME_COLORS.dark)
  })
})

describe('选过：固定在这台设备上', () => {
  it('选定一套就写进本机，之后不理会系统变化', () => {
    const system = stubSystem(false)
    dispose = initTheme()

    setThemeChoice('dark')

    expect(getThemeChoice()).toBe('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    system.set(true)
    system.set(false)
    expect(getTheme()).toBe('dark')
  })

  it('选回跟随系统就撤销固定，并立刻对齐系统当前的明暗', () => {
    const system = stubSystem(true)
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    dispose = initTheme()
    expect(getTheme()).toBe('light')

    setThemeChoice('system')

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    expect(getTheme()).toBe('dark')
    system.set(false)
    expect(getTheme()).toBe('light')
  })

  it('订阅者在每次变化后收到通知，退订后不再收到', () => {
    stubSystem(false)
    dispose = initTheme()
    const listener = vi.fn()
    const unsubscribe = subscribeTheme(listener)

    setThemeChoice('dark')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    setThemeChoice('light')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('本机存储不可用时本次选择仍然生效', () => {
    stubSystem(false)
    dispose = initTheme()
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })

    setThemeChoice('dark')

    expect(getTheme()).toBe('dark')
    setItem.mockRestore()
  })
})

describe('首帧脚本', () => {
  it.each([
    [null, false],
    [null, true],
    ['light', true],
    ['dark', false],
    ['system', true],
    ['garbage', true],
  ] as const)('已保存 %s、系统偏暗 %s 时与模块的解析结果一致', (stored, systemDark) => {
    stubSystem(systemDark)
    if (stored)
      localStorage.setItem(THEME_STORAGE_KEY, stored)

      // 这段脚本在页面里就是这样内联执行的，所以用间接 eval 在全局作用域里跑它。
    ;(0, eval)(THEME_BOOT_SCRIPT)

    const expected = resolveTheme(stored, systemDark)
    expect(document.documentElement.classList.contains('dark')).toBe(expected === 'dark')
    expect(themeColor()).toBe(THEME_COLORS[expected])
  })

  it('index.html 不再写死 theme-color，也不再有任何跟随系统配色的样式', () => {
    const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8')
    expect(html).not.toContain('theme-color')
    for (const file of ['../../index.css', '../../styles/theme.css']) {
      expect(readFileSync(resolve(__dirname, file), 'utf8')).not.toContain('prefers-color-scheme')
    }
  })

  it.each([
    '.mention-tag:hover',
    '.mention-tag.selected',
    '.slot-tag:hover',
    '.slot-tag.selected',
    '[contenteditable]::selection',
  ])('%s 的暗色写法关在 .dark 里，不会漏到亮色', (selector) => {
    const css = readFileSync(resolve(__dirname, '../../index.css'), 'utf8')
    const lines = css.split('\n').filter((line) => line.replace(/[,{\s]+$/, '').endsWith(selector))
    expect(lines.map((line) => line.trim().startsWith('.dark ')).sort()).toEqual([false, true])
  })

  it('由构建插件塞进 head 最前面，赶在样式与应用脚本之前执行', () => {
    const tags = themeBootPlugin().transformIndexHtml()
    expect(tags).toEqual([{ tag: 'script', children: THEME_BOOT_SCRIPT, injectTo: 'head-prepend' }])
  })
})
