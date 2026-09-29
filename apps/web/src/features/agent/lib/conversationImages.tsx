import type { AgentToolArtifact } from '@image-playground/shared'
import { useEffect, useRef, useState } from 'react'
import MediaImage from '../../../components/MediaImage'
import { i18next } from '../../../i18n'
import type { CanvasDoc, ImageEl } from '../../canvas/lib/canvasDoc'
import type { AgentPanelMessage } from '../types'
import { previewArtifactBitmap } from './artifactSource'

export interface ConversationImage {
  readonly id: string
  readonly label: string
  readonly title: string
  readonly source?: string
  readonly artifact: AgentToolArtifact
}

/** Conversation results remain references even when their canvas object was removed. */
export function conversationImages(
  messages: readonly AgentPanelMessage[],
  doc: CanvasDoc,
): ConversationImage[] {
  const seen = new Set<string>()
  const images: ConversationImage[] = []
  const elements = new Map(
    doc.elements.filter((el): el is ImageEl => el.type === 'image').map((el) => [el.id, el]),
  )
  for (const message of messages) {
    if (message.kind !== 'tool') continue
    for (const artifact of message.artifacts ?? []) {
      if (artifact.media !== 'image' || seen.has(artifact.artifactId)) continue
      seen.add(artifact.artifactId)
      const element = elements.get(artifact.artifactId)
      images.push({
        id: artifact.artifactId,
        label: i18next.t('mentions.resultImage', { ns: 'agent', index: images.length + 1 }),
        title: message.title,
        artifact,
        source: element ? doc.files[element.fileId] : undefined,
      })
    }
  }
  return images.reverse()
}

export function ConversationImageThumbnail({ image }: { image: ConversationImage }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [loaded, setLoaded] = useState<{ id: string; source: string | null }>()
  useEffect(() => {
    const element = ref.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { root: element.closest('[role="listbox"]'), rootMargin: '40px' },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible || image.source) return
    let current = true
    void previewArtifactBitmap(image.artifact).then((source) => {
      if (current) setLoaded({ id: image.id, source })
    })
    return () => {
      current = false
    }
  }, [visible, image.id, image.source, image.artifact])
  return (
    <span ref={ref} className="block h-full w-full">
      {visible && (
        <MediaImage
          src={image.source ?? (loaded?.id === image.id ? (loaded.source ?? undefined) : undefined)}
          alt=""
          className="h-full w-full object-cover"
        />
      )}
    </span>
  )
}
