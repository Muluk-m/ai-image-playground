import type Konva from 'konva'
import type { KonvaEventObject } from 'konva/lib/Node'
import { Group, Image as KImage, Rect, Text } from 'react-konva'
import type { CanvasDoc, TimelineEl } from '../lib/canvasDoc'
import { getLoadedImage } from '../lib/imageCache'
import { TIMELINE_PADDING, timelineSeconds, timelineSegments } from '../lib/timeline'

/** 片段缩略图所在那一条的上下留白与高度（页面单位）。 */
const STRIP_TOP = 28
const STRIP_HEIGHT = 72

function clock(seconds: number): string {
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * 画布上的时间线：一条横条，每段是源视频的封面，宽度按时长。源视频不在画布上的段画成
 * 灰底加「素材缺失」，不从条上消失。整条作为一个元素拖动 / 选中，不参与缩放旋转。
 */
export default function TimelineShape({
  el,
  doc,
  labels,
  common,
}: {
  el: TimelineEl
  doc: CanvasDoc
  labels: { title: string; missing: string }
  common: Konva.GroupConfig & {
    onPointerClick?: (e: KonvaEventObject<PointerEvent>) => void
    onDragStart?: (e: KonvaEventObject<DragEvent>) => void
    onDragMove?: (e: KonvaEventObject<DragEvent>) => void
    onDragEnd?: (e: KonvaEventObject<DragEvent>) => void
    onPointerEnter?: () => void
    onPointerLeave?: () => void
  }
}) {
  const lookup = (id: string) => doc.getElement(id)
  const segments = timelineSegments(el.clips, lookup)
  const total = timelineSeconds(el.clips, lookup)
  return (
    <Group {...common} x={el.x} y={el.y}>
      <Rect
        width={el.width}
        height={el.height}
        cornerRadius={10}
        fill="rgba(24,24,27,0.92)"
        stroke="rgba(167,139,250,0.9)"
        strokeWidth={2}
      />
      <Text
        x={TIMELINE_PADDING}
        y={8}
        text={`${labels.title} · ${el.clips.length} · ${clock(total)}`}
        fontSize={13}
        fill="#e4e4e7"
        listening={false}
      />
      {segments.map((segment) => {
        const source = doc.getElement(segment.elementId)
        const poster =
          !segment.missing && source?.type === 'image'
            ? getLoadedImage(source.fileId, doc.files[source.fileId], () => doc.notifyAssetLoaded())
            : null
        return (
          <Group
            key={`${segment.index}-${segment.elementId}`}
            x={segment.x}
            y={STRIP_TOP}
            listening={false}
          >
            <Rect
              width={segment.width}
              height={STRIP_HEIGHT}
              cornerRadius={6}
              fill={segment.missing ? 'rgba(113,113,122,0.6)' : '#000'}
            />
            {poster && (
              <KImage
                image={poster}
                width={segment.width}
                height={STRIP_HEIGHT}
                cornerRadius={6}
                crop={coverCrop(poster, segment.width, STRIP_HEIGHT)}
              />
            )}
            <Text
              x={4}
              y={STRIP_HEIGHT - 16}
              text={segment.missing ? labels.missing : clock(segment.seconds)}
              fontSize={11}
              fill={segment.missing ? '#fecaca' : '#fafafa'}
              shadowColor="#000"
              shadowBlur={2}
            />
          </Group>
        )
      })}
    </Group>
  )
}

/** 封面按段的宽高比居中裁切（cover），不拉伸。 */
function coverCrop(image: HTMLImageElement, width: number, height: number) {
  const sourceWidth = image.naturalWidth || image.width
  const sourceHeight = image.naturalHeight || image.height
  if (!sourceWidth || !sourceHeight) return undefined
  const scale = Math.max(width / sourceWidth, height / sourceHeight)
  const cropWidth = width / scale
  const cropHeight = height / scale
  return {
    x: (sourceWidth - cropWidth) / 2,
    y: (sourceHeight - cropHeight) / 2,
    width: cropWidth,
    height: cropHeight,
  }
}
