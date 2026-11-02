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
  /** 本会话批次项的 key：回复正文里出现时去掉，不给用户看（BUG-56）。 */
  readonly hiddenKeys: readonly string[]
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
  const keyList = messages.flatMap((message) =>
    message.kind === 'tool' ? (message.batchItemKeys ?? []) : [],
  )
  // 按内容记忆：消息每次流式更新都会换数组，key 没变就不让回复重新清洗。
  const keySignature = [...new Set(keyList)].sort().join('\n')
  const hiddenKeys = useMemo(() => (keySignature ? keySignature.split('\n') : []), [keySignature])
  const value = useMemo(
    () => ({ images, hiddenKeys, ...(onPreview ? { onPreview } : {}) }),
    [images, hiddenKeys, onPreview],
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

const NO_KEYS: readonly string[] = []

/** 回复正文要去掉的批次项 key；不在会话面板里（如灵感详情）时是空的。 */
export function useReplyHiddenKeys(): readonly string[] {
  return useContext(ReplyImagesContext)?.hiddenKeys ?? NO_KEYS
}

const EXTERNAL_LINK = /^(?:https?:|mailto:)/i

/**
 * 回复里的 Markdown 链接。外链照常新标签页打开；指向本会话图片的（模型常把产物 id 写成链接）
 * 改成点开图片查看；其余相对地址在这里都会解析到 `/p/...`，打不开还露出内部 id，只留文字（BUG-55）。
 */
export function AgentReplyLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { t } = useTranslation('agent')
  const context = useContext(ReplyImagesContext)
  if (href && EXTERNAL_LINK.test(href))
    return (
      <a
        className="text-primary underline decoration-primary/40 hover:text-primary"
        href={href}
        target="_blank"
        rel="noreferrer"
      >
        {children}
      </a>
    )
  const key = replyImageKey(href)
  const hit = key ? context?.images.get(key) : undefined
  const preview = context?.onPreview
  if (!hit || !preview) return <span>{children}</span>
  const name = typeof children === 'string' ? children : t('reply.image')
  return (
    <Button
      type="button"
      variant="link"
      aria-label={t('reply.openImage', { name })}
      className="inline h-auto cursor-zoom-in whitespace-normal p-0 align-baseline font-[inherit] text-[length:inherit] underline decoration-primary/40"
      onClick={() => preview(hit.messageId, hit.artifact.artifactId)}
    >
      {children}
    </Button>
  )
}
