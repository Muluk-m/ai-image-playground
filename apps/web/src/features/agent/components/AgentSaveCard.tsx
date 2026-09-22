import type {
  AgentAssetSaveCard,
  AgentLookSaveCard,
  AgentSaveCard as AgentSaveCardBlock,
  AgentSaveCardView,
  LookPurpose,
} from '@image-playground/shared'
import { Check, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { useTranslation } from '../../../i18n'
import { useLibraryStore } from '../../library/store'
import { CARD, CARD_NOTE, CARD_TITLE, THUMBNAIL_STATIC } from '../agentStyles'
import { postSave } from '../lib/agentClient'
import {
  AgentImageUnavailableError,
  type AgentSaveImage,
  type AgentSaveImageContext,
  agentImagePreview,
  storeAgentImages,
} from '../lib/saveCardImages'
import { useAgentStore } from '../store'
import type { AgentToolMessage } from '../types'

/** 枚举到译文 key 的对照。写成字面量，key 才有编译期检查（见 apps/web/CLAUDE.md 的 i18n 一节）。 */
const VIEW_KEY = {
  front: 'save.view.front',
  side: 'save.view.side',
  back: 'save.view.back',
  detail: 'save.view.detail',
  sheet: 'save.view.sheet',
  none: 'save.view.none',
} as const satisfies Record<AgentSaveCardView['label'], string>

const SOURCE_KEY = {
  upload: 'save.source.upload',
  generated: 'save.source.generated',
} as const satisfies Record<AgentSaveCardView['source'], string>

const KIND_KEY = {
  product: 'save.kind.product',
  person: 'save.kind.person',
} as const satisfies Record<AgentAssetSaveCard['assetKind'], string>

const BACKGROUND_KEY = {
  transparent: 'save.background.transparent',
  solid: 'save.background.solid',
} as const satisfies Record<AgentAssetSaveCard['background'], string>

const PURPOSE_KEY = {
  hero: 'save.purpose.hero',
  poster: 'save.purpose.poster',
  scene: 'save.purpose.scene',
  detail: 'save.purpose.detail',
} as const satisfies Record<LookPurpose, string>

/**
 * 这台设备这一程里已经存过的那几张卡，按工具调用 id 记着存成了什么名字。
 *
 * 卡片的真相在服务端那张结果块上，但它要等下次读回会话才更新；面板收起再展开、切页签都会
 * 把这个组件卸下重挂，没有这张表的话同一张卡会再存出一条重复记录。
 */
const savedInSession = new Map<string, string>()

type SaveFailure = 'failed' | 'imageGone'

/** 卡上每张图此刻的缩略图；还没取到的那几张先空着。 */
function usePreviews(imageIds: readonly string[], context: AgentSaveImageContext) {
  const [previews, setPreviews] = useState<Readonly<Record<string, string>>>({})
  const key = imageIds.join(' ')

  useEffect(() => {
    let alive = true
    for (const imageId of key ? key.split(' ') : []) {
      void agentImagePreview(imageId, context).then(
        (source) => {
          if (alive && source) setPreviews((before) => ({ ...before, [imageId]: source }))
        },
        () => {
          // 取不到就空着：卡照样存得下去，真正的字节在按下保存时再取一次。
        },
      )
    }
    return () => {
      alive = false
    }
    // 取图只跟这张卡上的图片 id 走；context 每次渲染都是新对象，不进依赖。
  }, [key])

  return previews
}

/** 这张卡取图、落库要的那点上下文；卡片卸下时掐掉还在途的取图。 */
function useSaveContext(): AgentSaveImageContext {
  const conversationId = useAgentStore((state) => state.conversationId)
  const messages = useAgentStore((state) => state.messages)
  const [controller] = useState(() => new AbortController())
  useEffect(() => () => controller.abort(), [controller])
  return { messages, conversationId, signal: controller.signal }
}

function NameRow({
  name,
  action,
  disabled,
  onChange,
  onSave,
}: {
  name: string
  action: string
  disabled: boolean
  onChange: (name: string) => void
  onSave: () => void
}) {
  const { t } = useTranslation('agent')
  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label={t('save.nameAria')}
        placeholder={t('save.namePlaceholder')}
        value={name}
        disabled={disabled}
        className="h-8 min-w-0 flex-1 text-xs"
        onChange={(event) => onChange(event.target.value)}
      />
      <Button type="button" size="sm" disabled={disabled || !name.trim()} onClick={onSave}>
        {action}
      </Button>
    </div>
  )
}

function Saved({ text }: { text: string }) {
  return (
    <div className={`${CARD_TITLE} flex items-center gap-1.5`}>
      <Check className="h-3.5 w-3.5 text-success" />
      {text}
    </div>
  )
}

function AssetSaveCard({ card, message }: { card: AgentAssetSaveCard; message: AgentToolMessage }) {
  const { t } = useTranslation('agent')
  const context = useSaveContext()
  const previews = usePreviews(
    card.views.map((view) => view.imageId),
    context,
  )
  const [dropped, setDropped] = useState<Readonly<Record<string, true>>>({})
  const [name, setName] = useState(card.name)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<SaveFailure | null>(null)
  const [saved, setSaved] = useState(
    card.status === 'saved' ? card.name : (savedInSession.get(message.toolCallId) ?? null),
  )
  const kept = card.views.filter((view) => !dropped[view.imageId])

  if (saved !== null) return <Saved text={t('save.savedAsset', { name: saved })} />

  const save = async () => {
    const conversationId = context.conversationId
    if (!conversationId) {
      setFailure('failed')
      return
    }
    setSaving(true)
    setFailure(null)
    try {
      const images: AgentSaveImage[] = kept.map((view) => ({
        agentImageId: view.imageId,
        source: view.source,
      }))
      const stored = await storeAgentImages(images, context)
      const record = await useLibraryStore.getState().saveAssetRecord({
        name: name.trim(),
        kind: card.assetKind,
        background: card.background,
        views: kept.map((view, at) => ({
          imageId: stored[at]!.imageId,
          label: view.label,
          source: view.source,
        })),
      })
      await postSave(conversationId, {
        toolCallId: message.toolCallId,
        kind: 'asset',
        recordId: record.id,
        name: record.name,
      })
      savedInSession.set(message.toolCallId, record.name)
      setSaved(record.name)
    } catch (thrown) {
      setFailure(thrown instanceof AgentImageUnavailableError ? 'imageGone' : 'failed')
      setSaving(false)
    }
  }

  return (
    <>
      <div className={CARD_TITLE}>{t('save.asset')}</div>
      <div className="flex flex-wrap gap-1.5">
        {card.views.map((view) => {
          const out = Boolean(dropped[view.imageId])
          const source = previews[view.imageId]
          const badge =
            view.label === 'none'
              ? t(SOURCE_KEY[view.source])
              : `${t(VIEW_KEY[view.label])} · ${t(SOURCE_KEY[view.source])}`
          return (
            <button
              key={view.imageId}
              type="button"
              title={badge}
              aria-label={out ? t('save.keep') : t('save.drop')}
              aria-pressed={!out}
              disabled={saving}
              className={`${THUMBNAIL_STATIC} ${out ? 'border-dashed opacity-35' : ''}`}
              onClick={() =>
                setDropped((before) => {
                  const { [view.imageId]: already, ...rest } = before
                  return already ? rest : { ...before, [view.imageId]: true }
                })
              }
            >
              {source && <img src={source} alt="" className="h-full w-full object-cover" />}
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 text-[10px] text-white">
                {badge}
              </span>
              {out && (
                <X className="absolute right-1 top-1 h-3.5 w-3.5 rounded bg-black/60 text-white" />
              )}
            </button>
          )
        })}
      </div>
      <div className={CARD_NOTE}>
        {t('save.assetMeta', {
          kind: t(KIND_KEY[card.assetKind]),
          background: t(BACKGROUND_KEY[card.background]),
        })}
      </div>
      <NameRow
        name={name}
        action={saving ? t('save.saving') : t('save.submit', { count: kept.length })}
        disabled={saving || kept.length === 0}
        onChange={setName}
        onSave={() => void save()}
      />
      {failure && (
        <p role="alert" className={CARD_NOTE}>
          {t(`save.${failure}`)}
        </p>
      )}
    </>
  )
}

function LookSaveCard({ card, message }: { card: AgentLookSaveCard; message: AgentToolMessage }) {
  const { t } = useTranslation('agent')
  const context = useSaveContext()
  const coverId = card.coverImageId ?? card.referenceImageIds[0]
  const previews = usePreviews(coverId ? [coverId] : [], context)
  const [name, setName] = useState(card.name)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<SaveFailure | null>(null)
  const [saved, setSaved] = useState(
    card.status === 'saved' ? card.name : (savedInSession.get(message.toolCallId) ?? null),
  )

  if (saved !== null) return <Saved text={t('save.savedLook', { name: saved })} />

  const save = async () => {
    const conversationId = context.conversationId
    if (!conversationId) {
      setFailure('failed')
      return
    }
    setSaving(true)
    setFailure(null)
    try {
      const images: AgentSaveImage[] = [
        ...card.referenceImageIds,
        ...(card.coverImageId ? [card.coverImageId] : []),
      ].map((agentImageId) => ({ agentImageId, source: 'generated' as const }))
      const stored = await storeAgentImages(images, context)
      const local = new Map(stored.map((one) => [one.agentImageId, one.imageId]))
      const record = await useLibraryStore.getState().saveLookRecord({
        ...(card.lookId ? { id: card.lookId } : {}),
        name: name.trim(),
        description: card.description,
        purpose: card.purpose,
        body: card.body,
        model: card.model,
        size: card.size,
        slotCount: card.slotCount,
        referenceImageIds: card.referenceImageIds.map((one) => local.get(one)!),
        coverImageId: card.coverImageId ? (local.get(card.coverImageId) ?? null) : null,
      })
      await postSave(conversationId, {
        toolCallId: message.toolCallId,
        kind: 'look',
        recordId: record.id,
        name: record.name,
      })
      savedInSession.set(message.toolCallId, record.name)
      setSaved(record.name)
    } catch (thrown) {
      setFailure(thrown instanceof AgentImageUnavailableError ? 'imageGone' : 'failed')
      setSaving(false)
    }
  }

  const cover = coverId ? previews[coverId] : undefined
  return (
    <>
      <div className={CARD_TITLE}>{t('save.look')}</div>
      <div className="flex gap-2">
        {cover && (
          <img
            src={cover}
            alt=""
            className="h-20 w-16 shrink-0 rounded-lg border border-border object-cover"
          />
        )}
        <p className="line-clamp-4 text-[11px] leading-relaxed text-muted-foreground">
          {card.description || card.body}
        </p>
      </div>
      <div className={CARD_NOTE}>
        {t('save.lookMeta', {
          purpose: t(PURPOSE_KEY[card.purpose]),
          model: card.model,
          size: card.size,
          slots: card.slotCount,
        })}
      </div>
      <NameRow
        name={name}
        action={saving ? t('save.saving') : t('save.submitLook')}
        disabled={saving}
        onChange={setName}
        onSave={() => void save()}
      />
      {failure && (
        <p role="alert" className={CARD_NOTE}>
          {t(`save.${failure}`)}
        </p>
      )}
    </>
  )
}

/**
 * 智能体备好的一条素材或一条模板：图在卡上，名字可改，按下保存才真正入库。
 *
 * 落库全在浏览器里——卡上的图片 id 是模型那一轮的说法，保存时先取回字节存进本机图片库，
 * 再写成素材 / 模板记录，最后才告诉服务端这张卡存过了（服务端据此让智能体接着说下去）。
 */
export default function AgentSaveCard({
  card,
  message,
}: {
  card: AgentSaveCardBlock
  message: AgentToolMessage
}) {
  return (
    <div className={CARD}>
      {card.kind === 'asset' ? (
        <AssetSaveCard card={card} message={message} />
      ) : (
        <LookSaveCard card={card} message={message} />
      )}
    </div>
  )
}
