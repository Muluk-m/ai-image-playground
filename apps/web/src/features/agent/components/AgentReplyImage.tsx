import type { AgentToolArtifact } from '@image-playground/shared'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Button } from '../../../components/ui/button'
import { useTranslation } from '../../../i18n'
import { artifactPreview, INLINE_RESULT_THUMBNAIL_SCALE } from '../lib/artifactPreview'
import type { AgentPanelMessage } from '../types'

interface ReplyImage {
  readonly messageId: string
  readonly artifact: AgentToolArtifact
}
interface ReplyImages {
  readonly images: ReadonlyMap<string, ReplyImage>
  readonly onPreview?: (messageId: string, objectId?: string, previewSource?: string) => void
}

const ReplyImagesContext = createContext<ReplyImages | null>(null)

/** 回复正文里模型可能写出的图片引用：会话图片 ID，或云媒体身份。 */
export function replyImageKey(src: string | undefined): string | undefined {
  if (!src) return undefined
  return (
    src.match(/agent_[0-9a-f-]{36}_\d+/i)?.[0] ??
    src.match(/aip-media:([0-9a-f-]{36})/i)?.[1] ??
    src.match(/^[0-9a-f-]{36}$/i)?.[0]
  )
}

/** 本会话已生成的图片，按图片 ID 与云媒体 id 都能查到。 */
export function AgentReplyImagesProvider({
  messages,
  onPreview,
  children,
}: {
  messages: readonly AgentPanelMessage[]
  onPreview?: ReplyImages['onPreview']
  children: ReactNode
}) {
  const images = useMemo(() => {
    const found = new Map<string, ReplyImage>()
    for (const message of messages) {
      if (message.kind !== 'tool') continue
      for (const artifact of message.artifacts ?? []) {
        if (artifact.media !== 'image') continue
        const entry = { messageId: message.id, artifact }
        found.set(artifact.artifactId, entry)
        if (artifact.mediaId) found.set(artifact.mediaId, entry)
      }
    }
    return found
  }, [messages])
  const value = useMemo(
    () => ({ images, ...(onPreview ? { onPreview } : {}) }),
    [images, onPreview],
  )
  return <ReplyImagesContext.Provider value={value}>{children}</ReplyImagesContext.Provider>
}

/**
 * 回复里的 Markdown 图片。只显示本会话生成过的图片；认不出的地址只留说明文字，
 * 不出裂图，也不替模型写的任意外链发请求。
 */
export function AgentReplyImage({ src, alt }: { src?: string; alt?: string }) {
  const { t } = useTranslation('agent')
  const context = useContext(ReplyImagesContext)
  const key = replyImageKey(src)
  const hit = key ? context?.images.get(key) : undefined
  // 缩略图跟着图片身份走：引用换成另一张图时，旧图的位图不会冒充新图显示或被拿去预览。
  const [loaded, setLoaded] = useState<{ identity: string; source: string | null }>()
  // 消息每次更新都会重建映射；按图片身份取图，同一张图不重复加载、不闪。
  const artifactRef = useRef(hit?.artifact)
  artifactRef.current = hit?.artifact
  const identity = hit ? `${hit.artifact.artifactId}:${hit.artifact.mediaId ?? ''}` : undefined
  useEffect(() => {
    const artifact = artifactRef.current
    if (!identity || !artifact) return
    let live = true
    void artifactPreview(artifact, INLINE_RESULT_THUMBNAIL_SCALE).then(
      (preview) => live && setLoaded({ identity, source: preview.source }),
      () => live && setLoaded({ identity, source: null }),
    )
    return () => {
      live = false
    }
  }, [identity])
  const source = loaded && loaded.identity === identity ? loaded.source : undefined
  const label = alt?.trim() || t('reply.image')
  if (!hit || source === null) return <span className="text-muted-foreground">{`[${label}]`}</span>
  const ratio =
    hit.artifact.width && hit.artifact.height
      ? `${hit.artifact.width} / ${hit.artifact.height}`
      : '1 / 1'
  const image =
    source === undefined ? (
      <span
        aria-label={label}
        role="img"
        className="block w-full animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
        style={{ aspectRatio: ratio }}
      />
    ) : (
      <img src={source} alt={label} className="block w-full rounded-lg" />
    )
  if (!context?.onPreview || source === undefined)
    return <span className="my-1 block max-w-80">{image}</span>
  const preview = context.onPreview
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={t('reply.openImage', { name: label })}
      className="my-1 block h-auto w-full max-w-80 cursor-zoom-in rounded-lg p-0 hover:bg-transparent"
      onClick={() => preview(hit.messageId, hit.artifact.artifactId, source)}
    >
      {image}
    </Button>
  )
}
