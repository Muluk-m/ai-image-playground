// @vitest-environment jsdom

vi.mock('../../../../lib/imagePreprocessing', async () => ({
  IMAGE_PREPROCESSING: { maxPixels: 4194304 },
  preprocessImageFile: (await import('../../../helpers/preparedImageFile')).preparedImageFile,
}))

import 'fake-indexeddb/auto'
import type { AgentMode, AgentSkillSummary, AgentTurnReference } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchAgentSkills = vi.hoisted(() => vi.fn<(mode: string) => Promise<AgentSkillSummary[]>>())

vi.mock('../../../../features/agent/lib/agentClient', async (original) => ({
  ...(await original<typeof import('../../../../features/agent/lib/agentClient')>()),
  fetchAgentSkills,
}))

// 首页交接走「有智能体面板」那条路：新建项目后把第一轮发出去。
vi.mock('../../../../features/agent/panelLayout', async (original) => ({
  ...(await original<typeof import('../../../../features/agent/panelLayout')>()),
  agentPanelPresent: () => true,
}))

// 首页的上传图进 image store；存图（含缩略图解码）不是这里要测的，换成按文件名给 id。
const UPLOADED = 'data:image/png;base64,dXBsb2FkZWQ='
vi.mock('../../../../store', async (original) => ({
  ...(await original<typeof import('../../../../store')>()),
  storeImageFromFile: async (file: File) => ({ id: `upload:${file.name}`, dataUrl: UPLOADED }),
}))

import InputBar from '../../../../components/InputBar'
import AgentComposer from '../../../../features/agent/components/AgentComposer'
import SkillStarterGuide from '../../../../features/agent/components/SkillStarterGuide'
import { agentDraft } from '../../../../features/agent/lib/drafts'
import { EMPTY_DRAFT } from '../../../../features/agent/lib/references'
import { resetAgentSkillsCache } from '../../../../features/agent/lib/useAgentSkills'
import { useAgentStore } from '../../../../features/agent/store'
import ProjectWelcome from '../../../../features/canvas/components/ProjectWelcome'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import type { CanvasWorkspace } from '../../../../features/canvas/lib/workspaces'
import { useCanvasProjectStore } from '../../../../features/canvas/projectStore'
import { useLibraryStore } from '../../../../features/library/store'
import type { AssetRecord } from '../../../../features/library/types'
import { putImage } from '../../../../lib/db'
import { useStore } from '../../../../store'
import { stubPointerApis } from '../../../helpers/radix'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const MAIN_IMAGE: AgentSkillSummary = {
  name: 'product-main-image',
  title: '电商主图',
  description: '何时用：主图。',
  icon: 'shopping-bag',
  summary: '商品主图',
  inputs: [
    {
      key: 'product',
      label: { 'zh-CN': '商品素材', en: 'Product' },
      required: true,
      multiple: true,
    },
  ],
  starters: [{ text: { 'zh-CN': '为 {product} 出一张白底主图' } }],
  scene: 'ecommerce',
  verified: true,
}

/** 两个位：交接到画布时编号要跟着位在句子里的次序，空着的那个留下位名。 */
const MODEL_SHOT: AgentSkillSummary = {
  name: 'model-shot',
  title: '模特图',
  description: '何时用：模特图。',
  icon: 'user-round',
  summary: '模特上身',
  inputs: [
    { key: 'product', label: { 'zh-CN': '商品素材' }, required: true, multiple: false },
    { key: 'model', label: { 'zh-CN': '模特' }, required: false, multiple: false },
  ],
  starters: [{ text: { 'zh-CN': '让 {model} 拿着 {product} 拍一张' } }],
  scene: 'scene-character',
  verified: true,
}

const COVER = 'data:image/png;base64,Y292ZXI='
const PIXEL = 'data:image/png;base64,cGl4ZWw='
const FRONT = 'data:image/png;base64,ZnJvbnQ='

/** 封面不是正面：位里该放的是正面那张（模板的视角选择规则），`@` 素材才带上全部视角。 */
const MUG: AssetRecord = {
  id: 'asset-mug',
  name: '红色马克杯',
  kind: 'product',
  views: [
    { imageId: 'mug-cover', label: 'none', source: 'upload' },
    { imageId: 'mug-front', label: 'front', source: 'upload' },
  ],
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: 1,
}

/** 最小的合法 PNG 头：够读成 data URL，也够压缩那一步认出是 PNG 而原样放过。 */
function png(name: string): File {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  return new File([bytes], name, { type: 'image/png' })
}

const PROJECT_ID = 'slot-project'

let host: HTMLDivElement
let root: Root
let send: ReturnType<
  typeof vi.fn<
    (text: string, references: readonly AgentTurnReference[] | undefined, mode?: AgentMode) => void
  >
>

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

/** 读图、读文件都是异步的：等它们落地，期间的重渲染算在 act 里。 */
async function until(assertion: () => void): Promise<void> {
  await act(async () => {
    await vi.waitFor(assertion)
  })
}

function navButton(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('nav button')].find((one) =>
    one.textContent?.includes(text),
  )
  if (!found) throw new Error(`no starter button "${text}"`)
  return found
}

/** 点场景、点起手句：输入框里得到技能胶囊、句子与空着的素材位。 */
function pickStarter(): void {
  click(navButton('电商'))
  click(navButton('白底主图'))
}

function editor(): HTMLElement {
  return host.querySelector<HTMLElement>('[contenteditable]')!
}

function slotChip(key = 'product'): HTMLButtonElement | null {
  return editor().querySelector<HTMLButtonElement>(`[data-asset-slot-chip="${key}"]`)
}

function panel(key = 'product'): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-asset-slot-panel="${key}"]`)
  if (!found) throw new Error('slot panel is not open')
  return found
}

function openSlot(key = 'product'): void {
  click(slotChip(key)!)
}

async function pickAsset(name: string, key = 'product'): Promise<void> {
  openSlot(key)
  click(panel(key).querySelector(`button[aria-label="${name}"]`)!)
  await until(() => expect(slotChip(key)?.hasAttribute('data-filled')).toBe(true))
}

async function upload(files: File[], key = 'product'): Promise<void> {
  openSlot(key)
  const input = panel(key).querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await until(() => expect(slotChip(key)?.hasAttribute('data-filled')).toBe(true))
}

/** 在句末打字，光标跟着落在句末——`@` 菜单按光标前的那一段找查询。 */
function type(text: string): void {
  const el = editor()
  const node = el.appendChild(document.createTextNode(text))
  window.getSelection()?.collapse(node, text.length)
  act(() => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(async () => {
  stubPointerApis()
  resetAgentSkillsCache()
  fetchAgentSkills.mockReset()
  fetchAgentSkills.mockResolvedValue([MAIN_IMAGE])
  await putImage({ id: 'mug-cover', dataUrl: COVER, createdAt: 1, source: 'upload' })
  await putImage({ id: 'mug-front', dataUrl: FRONT, createdAt: 1, source: 'upload' })
  useLibraryStore.setState({
    assets: [MUG],
    loadAssets: async () => {},
    noteAssetUsed: async () => {},
  })
  send = vi.fn()
  useAgentStore.setState({
    turn: 'idle',
    conversationId: null,
    createProject: async () => true,
    send: async (text, references, accepted, mode) => {
      send(text, references, mode)
      accepted?.()
    },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
  vi.unstubAllGlobals()
})

async function projectSetup(): Promise<void> {
  const session = agentDraft(null, PROJECT_ID)
  await vi.waitFor(() => expect(session.getSnapshot().loading).toBe(false))
  session.update(EMPTY_DRAFT)
  session.setSubmitting(false)
  useCanvasProjectStore.setState({
    projects: [
      {
        id: PROJECT_ID,
        name: '项目',
        customName: false,
        conversationId: null,
        sceneKey: `scene:${PROJECT_ID}`,
        createdAt: 0,
        updatedAt: 0,
        hasContent: false,
        kind: 'image',
      },
    ],
    activeId: PROJECT_ID,
  })
}

function slotPanelHeadings(): string[] {
  return [...panel().querySelectorAll('h3')].map((one) => one.textContent ?? '')
}

describe('项目输入框里的素材位', () => {
  let doc: CanvasDoc

  beforeEach(async () => {
    await projectSetup()
    doc = new CanvasDoc()
    act(() => {
      root.render(
        <>
          <AgentComposer doc={doc} />
          <SkillStarterGuide />
        </>,
      )
    })
    await settle()
  })

  const sendTurn = () => click(host.querySelector('button[aria-label="发送并拟提示词"]')!)

  it('起手句的位是空着的虚线胶囊；空着也能发，位名作普通文字发出', async () => {
    pickStarter()
    expect(slotChip()?.textContent).toBe('商品素材')
    expect(slotChip()?.hasAttribute('data-filled')).toBe(false)

    sendTurn()
    expect(send).toHaveBeenCalledWith('/product-main-image 为 商品素材 出一张白底主图', [], 'image')
  })

  it('从素材库选一条：位变成缩略图，按视角选择规则只发正面那张', async () => {
    pickStarter()
    await pickAsset('红色马克杯')
    expect(slotChip()?.querySelector('img')).not.toBeNull()
    expect(slotChip()?.textContent).toContain('红色马克杯')

    sendTurn()
    expect(send).toHaveBeenCalledWith(
      '/product-main-image 为 [image 1] 出一张白底主图',
      [{ imageId: 'mug-front', dataUrl: FRONT, name: '红色马克杯' }],
      'image',
    )
  })

  it('位里的图与 `@` 引用的同一张图按身份去重，只发一次', async () => {
    pickStarter()
    await pickAsset('红色马克杯')

    type(' 参考 @')
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')].filter((one) =>
      one.textContent?.includes('红色马克杯'),
    )
    // 最后一组是素材库：`@` 素材会附上它的全部视角，正面那张已经在位里了。
    act(() => {
      options[options.length - 1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await until(() =>
      expect(agentDraft(null, PROJECT_ID).getSnapshot().draft.references).toHaveLength(2),
    )

    sendTurn()
    const [text, references] = send.mock.calls[0]!
    expect(text).toBe('/product-main-image 为 [image 1] 出一张白底主图 参考 [image 2]')
    expect(references?.map((one) => one.imageId)).toEqual(['mug-front', 'mug-cover'])
  })

  it('上传同一主体的多张图：只作本轮参考图，位里装着全部', async () => {
    pickStarter()
    await upload([png('正面.png'), png('侧面.png')])
    expect(useLibraryStore.getState().assets).toEqual([MUG])

    sendTurn()
    const [text, references] = send.mock.calls[0]!
    expect(text).toBe('/product-main-image 为 [image 1] [image 2] 出一张白底主图')
    expect(references?.map((one) => one.name)).toEqual(['正面', '侧面'])
  })

  it('把图拖到胶囊上就填进这一位', async () => {
    pickStarter()
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', {
      value: { types: ['Files'], files: [png('拖进来.png')], items: [] },
    })
    act(() => {
      slotChip()!.dispatchEvent(drop)
    })
    await until(() => expect(slotChip()?.hasAttribute('data-filled')).toBe(true))

    sendTurn()
    const [text, references] = send.mock.calls[0]!
    expect(text).toBe('/product-main-image 为 [image 1] 出一张白底主图')
    expect(references?.map((one) => one.name)).toEqual(['拖进来'])
  })

  it('拿掉已填位的参考图，位回到空态', async () => {
    pickStarter()
    await pickAsset('红色马克杯')

    click(host.querySelector('button[aria-label="移除参考图 红色马克杯"]')!)
    expect(slotChip()?.hasAttribute('data-filled')).toBe(false)
    expect(slotChip()?.textContent).toBe('商品素材')

    sendTurn()
    expect(send).toHaveBeenCalledWith('/product-main-image 为 商品素材 出一张白底主图', [], 'image')
  })

  it('在胶囊上清空：位回到空态，图与删掉一个 `@` 胶囊时一样留在参考图条里', async () => {
    pickStarter()
    await upload([png('正面.png')])

    openSlot()
    click([...panel().querySelectorAll('button')].find((one) => one.textContent === '清空')!)
    expect(slotChip()?.hasAttribute('data-filled')).toBe(false)

    sendTurn()
    const [text, references] = send.mock.calls[0]!
    expect(text).toBe('/product-main-image 为 商品素材 出一张白底主图')
    expect(references?.map((one) => one.name)).toEqual(['正面'])
  })

  it('复制已填的位再粘回来，位和它装的图一起回来', async () => {
    pickStarter()
    await pickAsset('红色马克杯')

    const data = new Map<string, string>()
    const clipboard = {
      setData: (type: string, value: string) => void data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      files: [],
      items: [],
    }
    const clip = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: clipboard })
      act(() => {
        editor().dispatchEvent(event)
      })
    }
    const range = document.createRange()
    range.selectNode(editor().querySelector('.asset-slot-tag')!)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    clip('copy')

    const end = editor().lastChild!
    window.getSelection()!.collapse(end, end.textContent?.length ?? 0)
    clip('paste')

    sendTurn()
    const [text, references] = send.mock.calls[0]!
    expect(text).toBe('/product-main-image 为 [image 1] 出一张白底主图[image 1]')
    expect(references?.map((one) => one.imageId)).toEqual(['mug-front'])
  })

  /** 画布上放一张图，`@` 菜单与填位面板里都叫「画布图1」。 */
  function putCanvasImage(): void {
    act(() =>
      doc.restore(
        [
          {
            id: 'canvas-1',
            type: 'image',
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            rotation: 0,
            fileId: 'file-1',
          },
        ],
        { 'file-1': PIXEL },
      ),
    )
  }

  it('从画布选一张图填位：与 `@` 引用画布图是同一份参考图', async () => {
    putCanvasImage()
    pickStarter()
    openSlot()
    expect(slotPanelHeadings()).toEqual(['素材库', '画布'])
    click(panel().querySelector('button[aria-label="画布图1"]')!)
    expect(slotChip()?.hasAttribute('data-filled')).toBe(true)
    expect(slotChip()?.querySelector('img')?.getAttribute('src')).toBe(PIXEL)

    sendTurn()
    expect(send).toHaveBeenCalledWith(
      '/product-main-image 为 [image 1] 出一张白底主图',
      [{ imageId: 'canvas-1', dataUrl: PIXEL }],
      'image',
    )
  })

  it('同一张画布图经位与 `@` 两处引用，只发一次、编号相同', async () => {
    putCanvasImage()
    pickStarter()
    openSlot()
    click(panel().querySelector('button[aria-label="画布图1"]')!)

    // 进了位的画布图已经是参考图：`@` 菜单把它列成「@图1」，不再在画布组里重复出现。
    type(' 参考 @')
    const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options.map((one) => one.textContent)).not.toContain('画布图1')
    const option = options.find((one) => one.textContent === '@图1')!
    act(() => {
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    await until(() => expect(editor().querySelectorAll('img')).toHaveLength(2))

    sendTurn()
    expect(send).toHaveBeenCalledWith(
      '/product-main-image 为 [image 1] 出一张白底主图 参考 [image 1]',
      [{ imageId: 'canvas-1', dataUrl: PIXEL }],
      'image',
    )
  })

  it('画布上没有图时不出「画布」来源', () => {
    pickStarter()
    openSlot()
    expect(slotPanelHeadings()).toEqual(['素材库'])
  })

  it('删掉空位胶囊本身，位就没了', async () => {
    pickStarter()
    const el = editor()
    el.querySelector('.asset-slot-tag')!.remove()
    act(() => {
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(slotChip()).toBeNull()

    sendTurn()
    expect(send.mock.calls[0]?.[0]).not.toContain('商品素材')
  })
})

describe('首页对话输入框里的素材位', () => {
  beforeEach(async () => {
    useStore.setState({ prompt: '', inputImages: [], createTarget: 'chat', toast: null })
    act(() => {
      root.render(
        <>
          <InputBar inline />
          <SkillStarterGuide />
        </>,
      )
    })
    await settle()
  })

  function startCreating(): void {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (one) => one.textContent?.includes('开始创作') && !one.disabled,
    )
    if (!button) throw new Error('no start button')
    click(button)
  }

  it('与项目里是同一个胶囊：空位虚线，位名作普通文字交给画布第一轮', async () => {
    pickStarter()
    expect(slotChip()?.textContent).toBe('商品素材')

    startCreating()
    await until(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls[0]?.slice(0, 2)).toEqual([
      '/product-main-image 为 商品素材 出一张白底主图',
      [],
    ])
  })

  it('选素材填位后，交接到画布的第一轮带着这张参考图', async () => {
    pickStarter()
    await pickAsset('红色马克杯')
    expect(useStore.getState().inputImages.map((one) => one.id)).toEqual(['mug-front'])

    startCreating()
    await until(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls[0]?.slice(0, 2)).toEqual([
      '/product-main-image 为 [image 1] 出一张白底主图',
      [{ imageId: 'mug-front', dataUrl: FRONT }],
    ])
  })

  it('上传图填位：交接时按引用带过去，不建素材', async () => {
    pickStarter()
    await upload([png('正面.png')])
    expect(useLibraryStore.getState().assets).toEqual([MUG])

    startCreating()
    await until(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls[0]?.slice(0, 2)).toEqual([
      '/product-main-image 为 [image 1] 出一张白底主图',
      [{ imageId: 'upload:正面.png', dataUrl: UPLOADED }],
    ])
  })

  it('首页的填位面板没有「画布」来源', () => {
    pickStarter()
    openSlot()
    expect(slotPanelHeadings()).toEqual(['素材库'])
  })

  describe('两个位的技能', () => {
    beforeEach(async () => {
      fetchAgentSkills.mockResolvedValue([MODEL_SHOT])
      resetAgentSkillsCache()
      act(() => {
        root.render(
          <>
            <InputBar inline />
            <SkillStarterGuide key="two-slots" />
          </>,
        )
      })
      await settle()
      click(navButton('场景角色'))
      click(navButton('拍一张'))
    })

    it('先填后一个、再填前一个：交接时编号按句子次序，引用与文字对得上', async () => {
      await upload([png('模特.png')], 'model')
      await pickAsset('红色马克杯')

      startCreating()
      await until(() => expect(send).toHaveBeenCalled())
      const [text, references] = send.mock.calls[0]!
      expect(text).toBe('/model-shot 让 [image 1] 拿着 [image 2] 拍一张')
      expect(references?.map((one) => one.imageId)).toEqual(['upload:模特.png', 'mug-front'])
    })

    it('只填一个：交接时空位留下位名，已填的编号从 1 开始', async () => {
      await pickAsset('红色马克杯')

      startCreating()
      await until(() => expect(send).toHaveBeenCalled())
      expect(send.mock.calls[0]?.slice(0, 2)).toEqual([
        '/model-shot 让 模特 拿着 [image 1] 拍一张',
        [{ imageId: 'mug-front', dataUrl: FRONT }],
      ])
    })
  })

  it('拿掉参考图，位回到空态，交接时发位名', async () => {
    pickStarter()
    await pickAsset('红色马克杯')

    act(() => useStore.getState().removeInputImage(0))
    expect(slotChip()?.hasAttribute('data-filled')).toBe(false)
    expect(slotChip()?.textContent).toBe('商品素材')

    startCreating()
    await until(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls[0]?.slice(0, 2)).toEqual([
      '/product-main-image 为 商品素材 出一张白底主图',
      [],
    ])
  })
})

describe('空项目欢迎页的场景引导', () => {
  beforeEach(async () => {
    await projectSetup()
    const workspace = { doc: new CanvasDoc(), editor: undefined } as unknown as CanvasWorkspace
    act(() => {
      root.render(<ProjectWelcome workspace={workspace} />)
    })
    await settle()
  })

  it('与首页同一套场景与起手句，点了填进这张卡里的项目输入框', async () => {
    pickStarter()
    expect(slotChip()?.textContent).toBe('商品素材')
    expect(agentDraft(null, PROJECT_ID).getSnapshot().draft.prompt).toContain('白底主图')

    await pickAsset('红色马克杯')
    click(host.querySelector('button[aria-label="发送并拟提示词"]')!)
    expect(send).toHaveBeenCalledWith(
      '/product-main-image 为 [image 1] 出一张白底主图',
      [{ imageId: 'mug-front', dataUrl: FRONT, name: '红色马克杯' }],
      'image',
    )
  })
})
