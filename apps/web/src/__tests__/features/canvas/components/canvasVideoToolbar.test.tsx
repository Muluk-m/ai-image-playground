// @vitest-environment jsdom
import { VIDEO_MODEL_SUPPORT, type VideoGenerationRecord } from '@image-playground/shared'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'

vi.mock('../../../../lib/channels/videoChannels', () => ({
  isVideoModeAvailable: () => true,
  videoModelOptions: () => [
    {
      channelId: 'grok',
      modelId: 'grok-imagine-video',
      label: 'Grok',
      support: VIDEO_MODEL_SUPPORT['grok-imagine-video'],
    },
  ],
}))

const film = vi.hoisted(() => ({ supported: true }))
vi.mock('../../../../features/canvas/lib/exportFilm', () => ({
  filmExportSupported: () => Promise.resolve(film.supported),
}))

const agent = vi.hoisted(() => ({ on: false }))
vi.mock('../../../../features/agent/panelLayout', () => ({ agentPanelPresent: () => agent.on }))

const { default: CanvasVideoToolbar } = await import(
  '../../../../features/canvas/components/CanvasVideoToolbar'
)

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let doc: CanvasDoc
let editor: CanvasEditor

function addVideo(id: string, x: number, generation?: VideoGenerationRecord) {
  doc.addElements([
    {
      id,
      type: 'image',
      x,
      y: 100,
      width: 180,
      height: 320,
      rotation: 0,
      fileId: `file-${id}`,
      video: { taskId: `task-${id}`, outputIndex: 0, ...(generation ? { generation } : {}) },
    },
  ])
}

const record: VideoGenerationRecord = {
  model: 'grok-imagine-video',
  duration: 6,
  aspectRatio: '16:9',
  resolution: '720p',
}

function render() {
  act(() => root.render(<CanvasVideoToolbar editor={editor} />))
}

function button(name: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll('button')).find(
    (one) => one.getAttribute('aria-label') === name,
  )
}

beforeEach(() => {
  film.supported = true
  doc = new CanvasDoc()
  doc.setViewport(800, 600)
  editor = new CanvasEditor(doc)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('视频节点工具条', () => {
  it('shows the full toolbar for one clip and only add-to-timeline for several', () => {
    addVideo('a', 0, {
      model: 'grok-imagine-video',
      duration: 8,
      aspectRatio: '16:9',
      resolution: '720p',
    })
    addVideo('b', 400)
    render()
    expect(host.querySelector('[role="toolbar"]')).toBeNull()

    act(() => editor.setSelectedElements(['a']))
    expect(host.querySelector('[role="toolbar"]')).not.toBeNull()

    // 多选时只剩「加入时间线」：下载、续写这些动作只对单段有意义。
    act(() => editor.setSelectedElements(['a', 'b']))
    expect(host.querySelectorAll('[role="toolbar"] button')).toHaveLength(1)
  })

  it('offers extend for a recorded clip and explains why an unrecorded one cannot', () => {
    addVideo('recorded', 0, {
      model: 'grok-imagine-video',
      duration: 8,
      aspectRatio: '16:9',
      resolution: '720p',
    })
    addVideo('old', 400)
    render()

    act(() => editor.setSelectedElements(['recorded']))
    expect(button('续写')?.getAttribute('aria-disabled')).toBeNull()

    act(() => editor.setSelectedElements(['old']))
    // 不可用的按钮仍可聚焦，原因挂在按钮自己身上，键盘和读屏都拿得到。
    expect(button('续写')?.disabled).toBe(false)
    expect(button('续写')?.getAttribute('aria-disabled')).toBe('true')
    expect(button('续写')?.getAttribute('title')).toContain('时长')
  })

  it('offers adding several selected clips to a timeline', () => {
    addVideo('a', 0, {
      model: 'grok-imagine-video',
      duration: 8,
      aspectRatio: '16:9',
      resolution: '720p',
    })
    addVideo('b', 400)
    render()

    act(() => editor.setSelectedElements(['a', 'b']))
    const add = host.querySelector('[role="toolbar"] button') as HTMLButtonElement
    expect(add.getAttribute('aria-label')).toContain('2')
    act(() => add.click())

    const timeline = doc.elements.find((el) => el.type === 'timeline')
    expect(timeline?.type === 'timeline' && timeline.clips.map((clip) => clip.elementId)).toEqual([
      'a',
      'b',
    ])
  })

  it('offers editing a lone selected timeline, which touch users cannot double-click', async () => {
    const { useTimelineEditor } = await import('../../../../features/canvas/timelineEditorStore')
    doc.addElements([
      { id: 'tl', type: 'timeline', x: 0, y: 500, width: 300, height: 120, clips: [] },
    ])
    render()
    act(() => editor.setSelectedElements(['tl']))
    act(() => button('编辑时间线')?.click())
    expect(useTimelineEditor.getState().openId).toBe('tl')
    useTimelineEditor.getState().close()
  })

  it('exports a lone timeline, and names the missing clip when a source is gone', async () => {
    const { useFilmExport } = await import('../../../../features/canvas/filmExportStore')
    const start = vi.spyOn(useFilmExport.getState(), 'start').mockImplementation(() => {})
    addVideo('a', 0, record)
    doc.addElements([
      {
        id: 'tl',
        type: 'timeline',
        x: 0,
        y: 500,
        width: 300,
        height: 120,
        clips: [
          { elementId: 'a', in: 0, out: 6 },
          { elementId: 'gone', in: 0, out: 4 },
        ],
      },
    ])
    editor.setSelectedElements(['tl'])
    render()
    await act(async () => {})
    const exportButton = button('导出成片')!
    expect(exportButton.getAttribute('aria-disabled')).toBe('true')
    expect(exportButton.title).toContain('第 2 段')

    doc.updateElements([{ id: 'tl', patch: { clips: [{ elementId: 'a', in: 0, out: 6 }] } }])
    render()
    act(() => button('导出成片')!.click())
    expect(start).toHaveBeenCalledWith(
      'tl',
      [{ taskId: 'task-a', outputIndex: 0, in: 0, out: 6 }],
      'film',
    )
    start.mockRestore()
  })

  it('offers downloading all clips where the browser cannot encode H.264', async () => {
    film.supported = false
    addVideo('a', 0, record)
    doc.addElements([
      {
        id: 'tl',
        type: 'timeline',
        x: 0,
        y: 500,
        width: 300,
        height: 120,
        clips: [{ elementId: 'a', in: 0, out: 6 }],
      },
    ])
    editor.setSelectedElements(['tl'])
    render()
    await act(async () => {})
    expect(button('导出成片')!.getAttribute('aria-disabled')).toBe('true')
    expect(button('下载全部片段')).toBeDefined()
  })

  it('opens the regenerate dialog with the recorded prompt even where the agent panel replaces the generate bar', () => {
    agent.on = true
    doc.addElements([
      {
        id: 'plain',
        type: 'image',
        x: 0,
        y: 100,
        width: 180,
        height: 320,
        rotation: 0,
        fileId: 'file-plain',
        meta: { prompt: '标题', userPrompt: '海边奔跑的人' },
        video: {
          taskId: 'task-plain',
          outputIndex: 0,
          generation: {
            model: 'grok-imagine-video',
            duration: 8,
            aspectRatio: '16:9',
            resolution: '720p',
          },
        },
      },
    ])
    render()
    act(() => editor.setSelectedElements(['plain']))
    act(() => button('重新生成')?.click())
    const dialogPrompt = document.querySelector('textarea') as HTMLTextAreaElement | null
    expect(dialogPrompt?.value).toBe('海边奔跑的人')
    agent.on = false
  })
})
