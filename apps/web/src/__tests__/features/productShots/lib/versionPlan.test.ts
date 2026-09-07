import { describe, expect, it } from 'vitest'
import {
  editVersionPlan,
  resetVersionPrompt,
  type VersionPlanContext,
} from '../../../../features/productShots/lib/versionPlan'
import type { ProductShotVersion } from '../../../../features/productShots/types'

const CONTEXT: VersionPlanContext = {
  product: {
    name: 'W2753 独立浴缸',
    features: '蛋形单边斜背',
    mainColor: '哑光灰棕',
    forbiddenColors: ['米白'],
  },
  language: 'zh',
  preference: '',
  sceneType: 'photo',
}

function remixVersion(): ProductShotVersion {
  return {
    id: 'v1',
    taskId: 't1',
    plan: '浴缸靠窗斜放',
    prompt: '原始提示词',
    productBox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    masked: false,
    mode: 'remix',
    level: 'high',
    shotType: 'scene',
    brief: {
      composition: '浴缸靠窗斜放',
      camera: '略高的 3/4 侧视',
      lighting: '柔和窗光',
      background: '日式木质浴室',
      props: ['毛巾'],
      textZones: [],
      palette: ['米白'],
      productBox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    },
    copy: { title: '', subtitle: '' },
    createdAt: 1,
  }
}

function swapVersion(): ProductShotVersion {
  return {
    id: 'v2',
    taskId: 't2',
    plan: '放进有窗光的日式木质浴室',
    prompt: '原始提示词',
    productBox: null,
    masked: true,
    mode: 'background',
    createdAt: 1,
  }
}

describe('editing the brief of a remix version', () => {
  it('rebuilds the prompt out of the edited brief', () => {
    const next = editVersionPlan(remixVersion(), { brief: { background: '水泥灰浴室' } }, CONTEXT)

    expect(next.brief?.background).toBe('水泥灰浴室')
    expect(next.prompt).toContain('背景：水泥灰浴室')
    expect(next.prompt).toContain('图1是我方产品：W2753 独立浴缸')
  })

  it('writes the on-image copy of a selling point shot in the language of the job', () => {
    const version = { ...remixVersion(), shotType: 'selling-point' as const }

    const zh = editVersionPlan(version, { copy: { title: '一秒收纳' } }, CONTEXT)
    const en = editVersionPlan(
      version,
      { copy: { title: 'Folds in a second' } },
      {
        ...CONTEXT,
        language: 'en',
      },
    )

    expect(zh.prompt).toContain('图上文案用中文')
    expect(zh.prompt).toContain('标题「一秒收纳」')
    expect(en.prompt).toContain('图上文案用英文')
    expect(en.prompt).toContain('标题「Folds in a second」')
  })

  it('keeps the level the version was produced at', () => {
    const version = { ...remixVersion(), level: 'low' as const }

    const next = editVersionPlan(version, { brief: { lighting: '硬光' } }, CONTEXT)

    expect(next.prompt).toContain('图2只作为构图、机位与布光参考')
  })
})

describe('editing the plan of a background swap version', () => {
  it('rebuilds the prompt around the edited plan sentence', () => {
    const next = editVersionPlan(swapVersion(), { plan: '放进水泥灰的极简浴室' }, CONTEXT)

    expect(next.plan).toBe('放进水泥灰的极简浴室')
    expect(next.prompt).toContain('放进水泥灰的极简浴室')
  })

  it('names the inventory of the version in the untouched section', () => {
    const version = { ...swapVersion(), inventory: ['浴缸', '落地龙头'] }

    const next = editVersionPlan(version, { plan: '放进水泥灰的极简浴室' }, CONTEXT)

    expect(next.prompt).toContain('不动的部分：浴缸、落地龙头。')
  })

  it('falls back to the generic untouched clause for a version without an inventory', () => {
    const next = editVersionPlan(swapVersion(), { plan: '放进水泥灰的极简浴室' }, CONTEXT)

    expect(next.prompt).toContain('不动的部分：产品本身及所有功能上属于它的部件。')
  })

  it('rebuilds the prompt in the language of the job', () => {
    const next = editVersionPlan(
      { ...swapVersion(), inventory: ['the bathtub'] },
      { plan: 'A warm microcement bathroom' },
      { ...CONTEXT, language: 'en' },
    )

    expect(next.prompt).toContain('Untouched: the bathtub.')
    expect(next.prompt).toContain('To replace: A warm microcement bathroom')
    expect(next.prompt).not.toMatch(/[一-鿿]/)
  })

  it('takes the preference of the job into the rebuilt prompt', () => {
    const next = editVersionPlan(
      swapVersion(),
      { plan: '放进水泥灰的极简浴室' },
      {
        ...CONTEXT,
        preference: '北欧风',
      },
    )

    expect(next.prompt).toContain('用户偏好：北欧风')
  })

  it('keeps the product box the drawer edited', () => {
    const next = editVersionPlan(
      swapVersion(),
      { productBox: { x: 0, y: 0, w: 0.5, h: 0.5 } },
      CONTEXT,
    )

    expect(next.productBox).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 })
  })
})

describe('protecting a prompt someone wrote by hand', () => {
  it('marks the version as hand written and keeps the text', () => {
    const next = editVersionPlan(remixVersion(), { prompt: '我自己写的提示词' }, CONTEXT)

    expect(next.prompt).toBe('我自己写的提示词')
    expect(next.promptEdited).toBe(true)
  })

  it('leaves the hand written prompt alone when the brief changes afterwards', () => {
    const edited = editVersionPlan(remixVersion(), { prompt: '我自己写的提示词' }, CONTEXT)

    const next = editVersionPlan(edited, { brief: { background: '水泥灰浴室' } }, CONTEXT)

    expect(next.brief?.background).toBe('水泥灰浴室')
    expect(next.prompt).toBe('我自己写的提示词')
  })

  it('rebuilds the prompt and drops the mark when it is reset', () => {
    const edited = editVersionPlan(
      remixVersion(),
      { prompt: '我自己写的提示词', brief: { background: '水泥灰浴室' } },
      CONTEXT,
    )

    const next = resetVersionPrompt(edited, CONTEXT)

    expect(next.promptEdited).toBe(false)
    expect(next.prompt).toContain('背景：水泥灰浴室')
  })
})

describe('versions written before the drawer existed', () => {
  it('keeps the prompt of a remix version that has no brief', () => {
    const version: ProductShotVersion = { ...remixVersion(), brief: undefined, shotType: undefined }

    const next = editVersionPlan(version, { plan: '别的构图' }, CONTEXT)

    expect(next.prompt).toBe('原始提示词')
  })
})
