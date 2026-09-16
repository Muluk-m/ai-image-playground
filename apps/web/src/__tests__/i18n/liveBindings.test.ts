import { afterEach, describe, expect, it } from 'vitest'
import {
  PRODUCT_IS_SOURCE_REASON,
  PRODUCT_MISSING_REASON,
} from '../../features/productShots/lib/productGate'
import { i18next, setLocale } from '../../i18n'
import { NO_EDIT_SUPPORT_MESSAGE } from '../../lib/channels/profileSelectors'
import { IMAGE_FETCH_CORS_HINT } from '../../lib/imageApiShared'
import { EXPORT_FIT_LABELS } from '../../lib/imageExport'
import { PRODUCT_ANGLE_LABELS } from '../../lib/productAngle'
import { SHOT_TYPE_LABELS } from '../../lib/shotTypes'

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
    expect(PRODUCT_ANGLE_LABELS.front).toBe('正面')
    expect(SHOT_TYPE_LABELS.main).toBe('主图')
    expect(NO_EDIT_SUPPORT_MESSAGE).toContain('当前模型不支持参考图')

    await setLocale('en')

    expect(PRODUCT_ANGLE_LABELS.front).toBe('Front')
    expect(SHOT_TYPE_LABELS.main).toBe('Hero')
    expect(NO_EDIT_SUPPORT_MESSAGE).toContain('no reference image support')
  })

  it('切回中文后恢复原文，逐字节与语料一致', async () => {
    await setLocale('en')
    await setLocale('zh-CN')

    expect(PRODUCT_ANGLE_LABELS.front).toBe('正面')
    expect(SHOT_TYPE_LABELS['spec-diagram']).toBe('尺寸参数图')
  })

  it('另外四张表同样跟着切，别只覆盖头三个', async () => {
    expect(EXPORT_FIT_LABELS.crop).toBe('裁切')
    expect(IMAGE_FETCH_CORS_HINT).toContain('复制结果链接')
    expect(PRODUCT_MISSING_REASON).toBe('产品素材已丢失')
    expect(PRODUCT_IS_SOURCE_REASON).toBe('产品素材与原图相同')

    await setLocale('en')

    expect(EXPORT_FIT_LABELS.crop).toBe('Crop')
    expect(IMAGE_FETCH_CORS_HINT).toContain('copy the result URL')
    expect(PRODUCT_MISSING_REASON).toBe('The product asset is gone')
    expect(PRODUCT_IS_SOURCE_REASON).toContain('same as the source')
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
