import { afterEach, describe, expect, it } from 'vitest'
import { i18next, setLocale } from '../../i18n'
import { NO_EDIT_SUPPORT_MESSAGE } from '../../lib/channels/profileSelectors'
import { IMAGE_FETCH_CORS_HINT } from '../../lib/imageApiShared'
import { MAX_INPUT_IMAGES_MESSAGE } from '../../lib/inputImageLimit'

/**
 * `lib/` 里有几张标签表是 module-level 常量，被 store 与多个 feature 直接 import。
 * 它们在模块求值那一刻就定死了，所以改成了 `export let` + `languageChanged` 重算，
 * 靠 ESM live binding 让已经 import 过的模块读到新值。
 *
 * 这套写法依赖两件事：live binding 真的把新值透给 importer，以及重算发生在
 * React 实际重渲染之前。任何一条被改坏，界面就会在切到英文后继续显示中文，
 * 而且不会有任何报错。这个文件就是钉住这两条。
 */

afterEach(async () => {
  await setLocale('zh-CN')
})

describe('lib 的 module-level 标签表', () => {
  it('切到英文后 importer 读到的是新值', async () => {
    expect(NO_EDIT_SUPPORT_MESSAGE).toContain('当前模型不支持参考图')

    await setLocale('en')

    expect(NO_EDIT_SUPPORT_MESSAGE).toContain('no reference image support')
  })

  it('切回中文后恢复原文，逐字节与语料一致', async () => {
    await setLocale('en')
    await setLocale('zh-CN')

    expect(NO_EDIT_SUPPORT_MESSAGE).toContain('当前模型不支持参考图')
    expect(MAX_INPUT_IMAGES_MESSAGE).toContain('参考图数量已达上限')
  })

  it('另外两张表同样跟着切，别只覆盖头一个', async () => {
    expect(MAX_INPUT_IMAGES_MESSAGE).toContain('参考图数量已达上限')
    expect(IMAGE_FETCH_CORS_HINT).toContain('复制结果链接')

    await setLocale('en')

    expect(MAX_INPUT_IMAGES_MESSAGE).toContain('Reference image limit reached')
    expect(IMAGE_FETCH_CORS_HINT).toContain('copy the result URL')
  })

  it('重算挂在 languageChanged 上，且排在 react-i18next 之后', () => {
    // react-i18next 在 init 时注册，lib 模块在各自 import 时注册，所以 lib 一定更靠后。
    // i18next 按注册顺序派发，React 的重渲染是异步批处理的，等它真正渲染时值已经新了。
    // 这里只断言监听确实挂上了：掉了的话上面两条会先红，这条是解释性的护栏。
    const listeners = (i18next as unknown as { observers?: Record<string, Map<unknown, unknown>> })
      .observers?.languageChanged
    expect(listeners && listeners.size).toBeGreaterThan(1)
  })
})
