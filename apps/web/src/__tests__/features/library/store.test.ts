import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  selectVisibleAssets,
  selectVisibleTemplates,
  useLibraryStore,
} from '../../../features/library/store'
import { storeImage } from '../../../lib/db'
import { API_MAX_IMAGES } from '../../../lib/inputImageLimit'
import { getSelectedImageMentionLabel } from '../../../lib/promptImageMentions'
import { useStore } from '../../../store'
import { DEFAULT_PARAMS } from '../../../types'

const IMAGE_A = 'data:image/png;base64,AAAA'
const IMAGE_B = 'data:image/png;base64,BBBB'

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  useStore.setState({
    inputImages: [],
    prompt: '',
    params: { ...DEFAULT_PARAMS },
    showToast: vi.fn(),
    setConfirmDialog: vi.fn(),
  })
  useLibraryStore.setState({
    assets: [],
    templates: [],
    searchKeyword: '',
    panelOpen: false,
    tab: 'assets',
    detailTemplateId: null,
    pendingAssetNames: [],
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('saving an asset', () => {
  it('keeps the name and image id, and survives a reload', async () => {
    const imageId = await storeImage(IMAGE_A)

    await useLibraryStore.getState().saveAsset(imageId, '产品白底图')

    useLibraryStore.setState({ assets: [] })
    await useLibraryStore.getState().loadAssets()
    const [asset] = useLibraryStore.getState().assets
    expect(asset.name).toBe('产品白底图')
    expect(asset.imageId).toBe(imageId)
  })

  it('refuses a blank name', async () => {
    const imageId = await storeImage(IMAGE_A)

    await useLibraryStore.getState().saveAsset(imageId, '   ')

    expect(useLibraryStore.getState().assets).toEqual([])
  })

  it('lets one image carry several names', async () => {
    const imageId = await storeImage(IMAGE_A)

    await useLibraryStore.getState().saveAsset(imageId, '白底图')
    await useLibraryStore.getState().saveAsset(imageId, '主图')

    const assets = useLibraryStore.getState().assets
    expect(assets.map((asset) => asset.name).sort()).toEqual(['主图', '白底图'])
    expect(assets.every((asset) => asset.imageId === imageId)).toBe(true)
  })
})

describe('attaching an asset', () => {
  it('adds the image to the reference strip', async () => {
    const imageId = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(imageId, '白底图')
    const [asset] = useLibraryStore.getState().assets

    await useLibraryStore.getState().attachAsset(asset.id)

    expect(useStore.getState().inputImages).toEqual([{ id: imageId, dataUrl: IMAGE_A }])
  })

  it('does not add the same image twice and reuses its position', async () => {
    const imageId = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(imageId, '白底图')
    await useLibraryStore.getState().saveAsset(imageId, '主图')
    const [first, second] = useLibraryStore.getState().assets

    expect(await useLibraryStore.getState().attachAsset(first.id)).toBe(0)
    expect(await useLibraryStore.getState().attachAsset(second.id)).toBe(0)
    expect(useStore.getState().inputImages).toHaveLength(1)
  })

  it('returns the position it landed at behind existing reference images', async () => {
    const idA = await storeImage(IMAGE_A)
    const idB = await storeImage(IMAGE_B)
    useStore.getState().addInputImage({ id: idA, dataUrl: IMAGE_A })
    await useLibraryStore.getState().saveAsset(idB, '场景图')

    expect(
      await useLibraryStore.getState().attachAsset(useLibraryStore.getState().assets[0].id),
    ).toBe(1)
  })

  it('records the last use', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    const imageId = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(imageId, '白底图')

    now.mockReturnValue(5000)
    await useLibraryStore.getState().attachAsset(useLibraryStore.getState().assets[0].id)

    expect(useLibraryStore.getState().assets[0].lastUsedAt).toBe(5000)
  })

  it('closes the panel and reports the attachment', async () => {
    const imageId = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(imageId, '白底图')
    useLibraryStore.setState({ panelOpen: true })

    await useLibraryStore.getState().attachAsset(useLibraryStore.getState().assets[0].id)

    expect(useLibraryStore.getState().panelOpen).toBe(false)
    expect(useStore.getState().showToast).toHaveBeenCalledWith('已加入参考图', 'success')
  })

  it('reports an image that is already in the strip', async () => {
    const imageId = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(imageId, '白底图')
    const [asset] = useLibraryStore.getState().assets
    await useLibraryStore.getState().attachAsset(asset.id)
    useLibraryStore.setState({ panelOpen: true })

    await useLibraryStore.getState().attachAsset(asset.id)

    expect(useStore.getState().inputImages).toHaveLength(1)
    expect(useStore.getState().showToast).toHaveBeenLastCalledWith('已在参考图中', 'info')
  })

  it('refuses once the reference strip is full', async () => {
    const imageId = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(imageId, '白底图')
    useStore.setState({
      inputImages: Array.from({ length: API_MAX_IMAGES }, (_, index) => ({
        id: `filler-${index}`,
        dataUrl: IMAGE_B,
      })),
    })

    expect(
      await useLibraryStore.getState().attachAsset(useLibraryStore.getState().assets[0].id),
    ).toBeNull()
    expect(useStore.getState().inputImages).toHaveLength(API_MAX_IMAGES)
    expect(useStore.getState().showToast).toHaveBeenCalledWith(
      expect.stringContaining('已达上限'),
      'error',
    )
  })
})

describe('managing assets', () => {
  it('renames one', async () => {
    const imageId = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(imageId, '旧名字')
    const [asset] = useLibraryStore.getState().assets

    await useLibraryStore.getState().renameAsset(asset.id, '新名字')

    useLibraryStore.setState({ assets: [] })
    await useLibraryStore.getState().loadAssets()
    expect(useLibraryStore.getState().assets[0].name).toBe('新名字')
  })

  it('keeps the old name when the new one is blank', async () => {
    const imageId = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(imageId, '旧名字')
    const [asset] = useLibraryStore.getState().assets

    await useLibraryStore.getState().renameAsset(asset.id, '  ')

    expect(useLibraryStore.getState().assets[0].name).toBe('旧名字')
  })

  it('deletes one without touching the image', async () => {
    const imageId = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(imageId, '白底图')
    const [asset] = useLibraryStore.getState().assets

    await useLibraryStore.getState().deleteAsset(asset.id)

    useLibraryStore.setState({ assets: [] })
    await useLibraryStore.getState().loadAssets()
    expect(useLibraryStore.getState().assets).toEqual([])
    await expect(useLibraryStore.getState().attachAsset(asset.id)).resolves.toBeNull()
    expect(useStore.getState().inputImages).toEqual([])
  })
})

const mention = getSelectedImageMentionLabel

async function saveAssetNamed(dataUrl: string, name: string) {
  const imageId = await storeImage(dataUrl)
  await useLibraryStore.getState().saveAsset(imageId, name)
  const asset = useLibraryStore.getState().assets.find((a) => a.name === name)
  if (!asset) throw new Error('asset not saved')
  return asset
}

/** 存一个引用了 `白底图` 的模板，返回它与那条素材。 */
async function saveTemplateReferencingAsset(name = '锁产品前缀') {
  const asset = await saveAssetNamed(IMAGE_A, '白底图')
  await useLibraryStore.getState().attachAsset(asset.id)
  useStore.setState({
    prompt: `${mention(0)} 换背景`,
    params: { ...DEFAULT_PARAMS, size: '1536x1024', quality: 'high', n: 3 },
  })

  await useLibraryStore.getState().saveTemplate(name)
  const template = useLibraryStore.getState().templates.find((t) => t.name === name)
  if (!template) throw new Error('template not saved')

  useStore.setState({ inputImages: [], prompt: '', params: { ...DEFAULT_PARAMS } })
  return { asset, template }
}

describe('saving a template', () => {
  it('snapshots the marked prompt, the referenced assets and the params', async () => {
    const { asset } = await saveTemplateReferencingAsset()

    useLibraryStore.setState({ templates: [] })
    await useLibraryStore.getState().loadTemplates()
    const [template] = useLibraryStore.getState().templates
    expect(template.name).toBe('锁产品前缀')
    expect(template.prompt).toBe(`${mention(0)} 换背景`)
    expect(template.assetIds).toEqual([asset.id])
    expect(template.params).toEqual({ size: '1536x1024', quality: 'high', n: 3 })
  })

  it('refuses a blank name', async () => {
    useStore.setState({ prompt: '前缀' })

    await useLibraryStore.getState().saveTemplate('   ')

    expect(useLibraryStore.getState().templates).toEqual([])
  })
})

describe('applying a template', () => {
  it('attaches the missing asset image behind the current ones and remaps the reference', async () => {
    const { asset, template } = await saveTemplateReferencingAsset()
    useStore.setState({ inputImages: [{ id: 'other', dataUrl: IMAGE_B }] })

    await useLibraryStore.getState().applyTemplate(template.id)

    expect(useStore.getState().inputImages.map((image) => image.id)).toEqual([
      'other',
      asset.imageId,
    ])
    expect(useStore.getState().prompt).toBe(`${mention(1)} 换背景`)
    expect(useStore.getState().params).toMatchObject({
      size: '1536x1024',
      quality: 'high',
      n: 3,
    })
  })

  it('reuses a reference image that is already attached', async () => {
    const { asset, template } = await saveTemplateReferencingAsset()
    useStore.setState({ inputImages: [{ id: asset.imageId, dataUrl: IMAGE_A }] })

    await useLibraryStore.getState().applyTemplate(template.id)

    expect(useStore.getState().inputImages).toHaveLength(1)
    expect(useStore.getState().prompt).toBe(`${mention(0)} 换背景`)
  })

  it('still applies when the asset was deleted, showing the reference as removed', async () => {
    const { asset, template } = await saveTemplateReferencingAsset()
    await useLibraryStore.getState().deleteAsset(asset.id)

    await useLibraryStore.getState().applyTemplate(template.id)

    expect(useStore.getState().inputImages).toEqual([])
    expect(useStore.getState().prompt).toBe('@已移除图片 换背景')
  })

  it('asks before overwriting a non-empty prompt', async () => {
    const { template } = await saveTemplateReferencingAsset()
    useStore.setState({ prompt: '正在写的提示词' })

    await useLibraryStore.getState().applyTemplate(template.id)

    expect(useStore.getState().prompt).toBe('正在写的提示词')
    const dialog = vi.mocked(useStore.getState().setConfirmDialog).mock.calls[0][0]
    dialog?.action()
    await vi.waitFor(() => expect(useStore.getState().prompt).toBe(`${mention(0)} 换背景`))
  })

  it('refuses when attaching would pass the reference image cap', async () => {
    const { template } = await saveTemplateReferencingAsset()
    useStore.setState({
      inputImages: Array.from({ length: API_MAX_IMAGES }, (_, index) => ({
        id: `filler-${index}`,
        dataUrl: IMAGE_B,
      })),
    })

    await useLibraryStore.getState().applyTemplate(template.id)

    expect(useStore.getState().prompt).toBe('')
    expect(useStore.getState().showToast).toHaveBeenCalledWith(
      expect.stringContaining('已达上限'),
      'error',
    )
  })

  it('records the last use', async () => {
    const { template } = await saveTemplateReferencingAsset()
    vi.spyOn(Date, 'now').mockReturnValue(9000)

    await useLibraryStore.getState().applyTemplate(template.id)

    expect(useLibraryStore.getState().templates[0].lastUsedAt).toBe(9000)
  })

  it('leaves the panel and the detail behind', async () => {
    const { template } = await saveTemplateReferencingAsset()
    useLibraryStore.setState({ panelOpen: true, detailTemplateId: template.id })

    await useLibraryStore.getState().applyTemplate(template.id)

    expect(useLibraryStore.getState().panelOpen).toBe(false)
    expect(useLibraryStore.getState().detailTemplateId).toBeNull()
  })
})

describe('managing templates', () => {
  it('renames one and refuses a blank name', async () => {
    const { template } = await saveTemplateReferencingAsset()

    await useLibraryStore.getState().renameTemplate(template.id, '  ')
    expect(useLibraryStore.getState().templates[0].name).toBe('锁产品前缀')

    await useLibraryStore.getState().renameTemplate(template.id, '新名字')
    useLibraryStore.setState({ templates: [] })
    await useLibraryStore.getState().loadTemplates()
    expect(useLibraryStore.getState().templates[0].name).toBe('新名字')
  })

  it('deletes one and closes its detail', async () => {
    const { template } = await saveTemplateReferencingAsset()
    useLibraryStore.setState({ detailTemplateId: template.id })

    await useLibraryStore.getState().deleteTemplate(template.id)

    expect(useLibraryStore.getState().detailTemplateId).toBeNull()

    useLibraryStore.setState({ templates: [] })
    await useLibraryStore.getState().loadTemplates()
    expect(useLibraryStore.getState().templates).toEqual([])
  })

  it('lists the most recently used first and filters by name', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    useStore.setState({ prompt: '前缀' })
    await useLibraryStore.getState().saveTemplate('锁产品前缀')
    now.mockReturnValue(2000)
    await useLibraryStore.getState().saveTemplate('分镜风格后缀')

    expect(
      selectVisibleTemplates(useLibraryStore.getState()).map((template) => template.name),
    ).toEqual(['分镜风格后缀', '锁产品前缀'])

    useLibraryStore.getState().setSearch('锁产品')
    expect(
      selectVisibleTemplates(useLibraryStore.getState()).map((template) => template.name),
    ).toEqual(['锁产品前缀'])
  })
})

describe('browsing assets', () => {
  it('lists the most recently used first and filters by name', async () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(1000)
    const idA = await storeImage(IMAGE_A)
    await useLibraryStore.getState().saveAsset(idA, '白底图')
    now.mockReturnValue(2000)
    const idB = await storeImage(IMAGE_B)
    await useLibraryStore.getState().saveAsset(idB, '场景图')

    expect(selectVisibleAssets(useLibraryStore.getState()).map((asset) => asset.name)).toEqual([
      '场景图',
      '白底图',
    ])

    useLibraryStore.getState().setSearch('白底')
    expect(selectVisibleAssets(useLibraryStore.getState()).map((asset) => asset.name)).toEqual([
      '白底图',
    ])
  })
})
