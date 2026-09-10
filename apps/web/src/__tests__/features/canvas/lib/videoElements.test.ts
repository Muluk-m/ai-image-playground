import { beforeEach, describe, expect, it } from 'vitest'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'
import { CanvasEditor } from '../../../../features/canvas/lib/editor'
import { canvasVideos, videoElementMeta } from '../../../../features/canvas/lib/videoElements'
import { _setRuntimeConfigForTesting } from '../../../../lib/runtimeConfig'

const PIXEL = 'data:image/png;base64,AQID'

let doc: CanvasDoc
let editor: CanvasEditor

beforeEach(() => {
  _setRuntimeConfigForTesting({ bff: { enabled: true, baseUrl: 'http://bff.test' } })
  doc = new CanvasDoc()
  doc.setViewport(800, 600)
  editor = new CanvasEditor(doc)
})

describe('画布上的视频对象', () => {
  it('把播放来源认成一个可播放的对象', () => {
    editor.placeImages([
      {
        id: 'agent_video_1',
        dataUrl: PIXEL,
        x: 10,
        y: 20,
        width: 320,
        height: 180,
        meta: videoElementMeta({ taskId: 'task-2', outputIndex: 1 }),
      },
    ])

    expect(canvasVideos(editor)).toEqual([
      {
        id: 'agent_video_1',
        x: 10,
        y: 20,
        width: 320,
        height: 180,
        rotation: 0,
        url: 'http://bff.test/v1/queue/requests/task-2/output/1',
      },
    ])
  })

  it('没有播放来源的图片不算视频', () => {
    editor.placeImages([{ id: 'plain', dataUrl: PIXEL, x: 0, y: 0, width: 10, height: 10 }])

    expect(canvasVideos(editor)).toEqual([])
  })
})
