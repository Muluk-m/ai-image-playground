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

function themeColor(): string | null {
  return document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null
}

/** 可控的系统明暗。`calls` 用来确认非 system 选择不会去读它。 */
function stubSystem(matches: boolean): { set(next: boolean): void; calls: number } {
  const state = { matches, calls: 0 }
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  vi.stubGlobal('matchMedia', (query: string) => {
    expect(query).toBe('(prefers-color-scheme: dark)')
    state.calls += 1
    return {
      get matches() {
        return state.matches
      },
      media: query,
      addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
        if (type === 'change') listeners.add(listener)
      },
      removeEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener)
      },
    }
  })
  return {
    set(next: boolean) {
      state.matches = next
      for (const listener of listeners) listener({ matches: next } as MediaQueryListEvent)
    },
    get calls() {
      return state.calls
    },
  }
}

beforeEach(() => {
  localStorage.clear()
  document.documentElement.className = ''
  // 真实页面里首帧脚本排在 head 最前面，那一刻还没有任何 meta，所以这里也从空的 head 起步。
  document.head.innerHTML = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resolveTheme', () => {
  it.each([
    [null, true, 'dark'],
    [null, false, 'dark'],
    ['light', true, 'light'],
    ['light', false, 'light'],
    ['dark', false, 'dark'],
    ['system', true, 'dark'],
    ['system', false, 'light'],
    ['garbage', false, 'dark'],
  ] as const)('已保存 %s、系统偏暗 %s → %s', (stored, systemDark, expected) => {
    expect(resolveTheme(stored, systemDark)).toBe(expected)
  })
})

describe('没选过：默认暗色', () => {
  it('系统明暗不会影响默认主题', () => {
    const system = stubSystem(false)
    initTheme()

    expect(getThemeChoice()).toBe('dark')
    expect(getTheme()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(themeColor()).toBe(THEME_COLORS.dark)
    expect(system.calls).toBe(0)
  })
})

describe('选过：固定在这台设备上', () => {
  it('手动选亮色会保存，刷新后仍是亮色；选回暗色也会保存', () => {
    initTheme()
    setThemeChoice('light')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light')
    expect(getTheme()).toBe('light')
    expect(themeColor()).toBe(THEME_COLORS.light)

    initTheme()
    expect(getThemeChoice()).toBe('light')
    setThemeChoice('dark')
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(getTheme()).toBe('dark')
    expect(themeColor()).toBe(THEME_COLORS.dark)
  })

  it('选了跟随系统会保存，并在系统明暗变化时立刻换', () => {
    const system = stubSystem(true)
    initTheme()
    setThemeChoice('system')

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
    expect(getThemeChoice()).toBe('system')
    expect(getTheme()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    system.set(false)
    expect(getThemeChoice()).toBe('system')
    expect(getTheme()).toBe('light')
    expect(themeColor()).toBe(THEME_COLORS.light)

    initTheme()
    expect(getThemeChoice()).toBe('system')
    expect(getTheme()).toBe('light')
  })

  it('离开跟随系统之后，系统再变也不改当前主题', () => {
    const system = stubSystem(false)
    initTheme()
    setThemeChoice('system')
    setThemeChoice('dark')

    system.set(false)
    expect(getThemeChoice()).toBe('dark')
    expect(getTheme()).toBe('dark')
  })

  it('订阅者在每次变化后收到通知，退订后不再收到', () => {
    initTheme()
    const listener = vi.fn()
    const unsubscribe = subscribeTheme(listener)

    setThemeChoice('dark')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    setThemeChoice('light')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('本机存储不可用时本次选择仍然生效', () => {
    initTheme()
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })

    setThemeChoice('light')

    expect(getTheme()).toBe('light')
    setItem.mockRestore()
  })
})

describe('首帧脚本', () => {
  it.each([
    [null, true],
    [null, false],
    ['light', true],
    ['light', false],
    ['dark', true],
    ['dark', false],
    ['system', true],
    ['system', false],
    ['garbage', true],
    ['garbage', false],
  ] as const)('已保存 %s、系统偏暗 %s 时与模块的解析结果一致', (stored, systemDark) => {
    const system = stubSystem(systemDark)
    if (stored)
      localStorage.setItem(THEME_STORAGE_KEY, stored)

      // 这段脚本在页面里就是这样内联执行的，所以用间接 eval 在全局作用域里跑它。
    ;(0, eval)(THEME_BOOT_SCRIPT)

    const expected = resolveTheme(stored, systemDark)
    expect(document.documentElement.classList.contains('dark')).toBe(expected === 'dark')
    expect(themeColor()).toBe(THEME_COLORS[expected])
    if (stored === 'system') expect(system.calls).toBeGreaterThan(0)
    else expect(system.calls).toBe(0)
  })

  it('index.html 不写死 theme-color，样式也不按系统配色切换', () => {
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
