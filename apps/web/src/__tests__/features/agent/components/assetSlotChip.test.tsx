// @vitest-environment jsdom

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
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
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

const COVER = 'data:image/png;base64,Y292ZXI='
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

function slotChip(): HTMLButtonElement | null {
  return editor().querySelector<HTMLButtonElement>('[data-asset-slot-chip="product"]')
}

function panel(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[data-asset-slot-panel="product"]')
  if (!found) throw new Error('slot panel is not open')
  return found
}

function openSlot(): void {
  click(slotChip()!)
}

async function pickAsset(name: string): Promise<void> {
  openSlot()
  click(panel().querySelector(`button[aria-label="${name}"]`)!)
  await until(() => expect(slotChip()?.hasAttribute('data-filled')).toBe(true))
}

async function upload(files: File[]): Promise<void> {
  openSlot()
  const input = panel().querySelector<HTMLInputElement>('input[type="file"]')!
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await until(() => expect(slotChip()?.hasAttribute('data-filled')).toBe(true))
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

describe('项目输入框里的素材位', () => {
  beforeEach(async () => {
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
    act(() => {
      root.render(
        <>
          <AgentComposer doc={new CanvasDoc()} />
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
