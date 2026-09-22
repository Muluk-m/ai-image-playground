// PROTOTYPE：`/assets` 三页签（素材 / 提示词 / 模板）的三个变体，与模板卡「用它出图」批量弹窗。
// 额外一个「对话（原型）」页签：本地没起 BFF 时看不到智能体面板，这里用假面板承载保存卡片与输入框 chip。
import { Layers, Plus, Sparkles, Wand2 } from 'lucide-react'
import { useState } from 'react'
import Overlay from '../components/Overlay'
import { PANEL_SURFACE } from '../features/agent/agentStyles'
import { APP_MODE_LABELS, useStore } from '../store'
import BatchDialogPrototype from './BatchDialogPrototype'
import ComposerChipsPrototype, { PickedLookCapsule } from './ComposerChipsPrototype'
import CreateDialogPrototype from './CreateDialogPrototype'
import { ASSETS, LOOKS, PURPOSE_TONE, type ProtoAsset, type ProtoLook, type Purpose } from './data'
import LookDetailPrototype from './LookDetailPrototype'
import { useVariant } from './proto'
import SaveCardPrototype from './SaveCardPrototype'

type Tab = 'assets' | 'prompts' | 'looks' | 'chat'
const TAB_LABEL: Record<Tab, string> = { assets: '素材', prompts: '提示词', looks: '模板', chat: '对话（原型）' }
const AGENT_BUTTON =
  'inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground transition hover:opacity-90'
const GHOST_BUTTON =
  'inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] text-foreground transition hover:bg-muted'

/** 「用智能体创建」：跳到创作页、目标切成画布、把斜杠命令放进输入框，等用户自己点发送。 */
function handoffToAgent(command: string) {
  const store = useStore.getState()
  store.setCreateTarget('canvas')
  store.setPrompt(command)
  store.setAppMode('image')
}

export default function LibraryPrototype() {
  const variant = useVariant()
  const [tab, setTab] = useState<Tab>('looks')
  const [batchLook, setBatchLook] = useState<ProtoLook | null>(null)
  const [detail, setDetail] = useState<ProtoAsset | null>(null)
  const [lookDetail, setLookDetail] = useState<ProtoLook | null>(null)
  const [creating, setCreating] = useState<'asset' | 'look' | null>(null)

  return (
    <main className="flex min-h-[calc(100dvh-3.5rem)] flex-col">
      <div className="studio-page-head flex shrink-0 flex-wrap items-center gap-3 border-b border-border py-3 pl-5 pr-16 md:pr-60">
        <h1 className="font-display text-[15px] font-medium">{APP_MODE_LABELS.library}</h1>
        <div className="flex items-center gap-1">
          {(['assets', 'prompts', 'looks', 'chat'] as const).map((one) => (
            <button
              key={one}
              type="button"
              onClick={() => setTab(one)}
              aria-pressed={tab === one}
              className={`rounded-full px-3 py-1 text-[13px] transition-colors ${
                tab === one
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {TAB_LABEL[one]}
            </button>
          ))}
        </div>
        <label className="ml-auto flex h-9 w-full max-w-xs items-center rounded-lg border border-border px-3">
          <input
            type="search"
            placeholder={`搜索${TAB_LABEL[tab]}`}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </label>
        {tab === 'assets' && (
          <>
            <button type="button" onClick={() => setCreating('asset')} className={GHOST_BUTTON}>
              <Plus className="h-4 w-4" /> 新建素材
            </button>
            <button type="button" onClick={() => handoffToAgent('/create-asset ')} className={AGENT_BUTTON}>
              <Sparkles className="h-4 w-4" /> 用智能体创建素材
            </button>
          </>
        )}
        {tab === 'looks' && (
          <>
            <button type="button" onClick={() => setCreating('look')} className={GHOST_BUTTON}>
              <Plus className="h-4 w-4" /> 新建模板
            </button>
            <button type="button" onClick={() => handoffToAgent('/create-look ')} className={AGENT_BUTTON}>
              <Wand2 className="h-4 w-4" /> 用智能体创建模板
            </button>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 p-5">
        {tab === 'assets' && (
          <AssetsTab variant={variant} onOpen={setDetail} onCreate={() => setCreating('asset')} />
        )}
        {tab === 'prompts' && <PromptsTab />}
        {tab === 'looks' && (
          <LooksTab
            variant={variant}
            onBatch={setBatchLook}
            onOpen={setLookDetail}
            onCreate={() => setCreating('look')}
          />
        )}
        {tab === 'chat' && <ChatMock />}
      </div>

      {batchLook && <BatchDialogPrototype look={batchLook} onClose={() => setBatchLook(null)} />}
      {detail && <AssetDetail asset={detail} onClose={() => setDetail(null)} />}
      {lookDetail && (
        <LookDetailPrototype
          look={lookDetail}
          onClose={() => setLookDetail(null)}
          onBatch={(l) => {
            setLookDetail(null)
            setBatchLook(l)
          }}
          onAgent={handoffToAgent}
        />
      )}
      {creating && (
        <CreateDialogPrototype kind={creating} onClose={() => setCreating(null)} onAgent={handoffToAgent} />
      )}
    </main>
  )
}

/* ---------------- 素材 ---------------- */

/* ---------------- 对话假面板 ---------------- */

// 本地没起 BFF 时画布里没有智能体面板；这个假面板承载保存卡片与输入框 chip。
// 起了 BFF 时同样的东西挂在真实面板里（`/p/…?proto=looks`）。
function ChatMock() {
  return (
    <div className={`${PANEL_SURFACE} flex h-[calc(100dvh-9rem)] w-[380px] shrink-0 flex-col rounded-2xl`}>
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-2">
        <SaveCardPrototype />
      </div>
      <div className="border-t border-border px-2 py-2">
        <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-muted px-2.5 py-2 text-xs text-muted-foreground">
          <PickedLookCapsule />
          <span>描述你想要的图，或拖入参考…</span>
        </div>
        <ComposerChipsPrototype surface="agent" />
      </div>
    </div>
  )
}

function KindTag({ asset }: { asset: ProtoAsset }) {
  if (!asset.kind) return null
  return (
    <span className="rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">
      {asset.kind}
    </span>
  )
}

function BgTag({ asset }: { asset: ProtoAsset }) {
  if (!asset.background) return null
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-[10px] ${asset.background === '透明' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'}`}
    >
      {asset.background === '透明' ? '透明底' : '白底'}
    </span>
  )
}

function AssetsTab({
  variant,
  onOpen,
  onCreate,
}: { variant: string; onOpen: (a: ProtoAsset) => void; onCreate: () => void }) {
  if (variant === 'B') {
    // B：卡片下方带视角缩略条，一眼看全组。
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <NewTile label="新建素材" onClick={onCreate} />
        {ASSETS.map((asset) => (
          <button
            key={asset.id}
            type="button"
            onClick={() => onOpen(asset)}
            className="flex flex-col gap-2 rounded-xl border border-border bg-card p-2 text-left transition hover:border-primary"
          >
            <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-muted">
              <img src={asset.views[0].src} alt="" className="h-full w-full object-cover" />
              <div className="absolute left-1.5 top-1.5 flex gap-1">
                <KindTag asset={asset} />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[13px] font-medium">{asset.name}</span>
              <BgTag asset={asset} />
            </div>
            <div className="flex gap-1">
              {asset.views.map((view, i) => (
                <div key={i} className="flex flex-col items-center gap-0.5">
                  <img
                    src={view.src}
                    alt=""
                    className="h-10 w-10 rounded-md border border-border object-cover"
                  />
                  <span className="text-[10px] text-muted-foreground">{view.label}</span>
                </div>
              ))}
            </div>
          </button>
        ))}
      </div>
    )
  }
  if (variant === 'C') {
    // C：表格式，产品 / 人物分组，视角在一行里。
    const groups: Array<[string, ProtoAsset[]]> = [
      ['产品', ASSETS.filter((a) => a.kind === '产品')],
      ['人物', ASSETS.filter((a) => a.kind === '人物')],
      ['未分类（旧素材）', ASSETS.filter((a) => !a.kind)],
    ]
    return (
      <div className="flex flex-col gap-6">
        {groups.map(([title, list]) => (
          <section key={title}>
            <h2 className="mb-2 text-xs font-medium text-muted-foreground">
              {title} · {list.length}
            </h2>
            <div className="divide-y divide-border rounded-xl border border-border">
              {list.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => onOpen(asset)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left transition hover:bg-muted"
                >
                  <img
                    src={asset.views[0].src}
                    alt=""
                    className="h-14 w-14 rounded-lg border border-border object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium">{asset.name}</span>
                      <BgTag asset={asset} />
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {asset.views.map((view, i) => (
                        <span
                          key={i}
                          className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {view.label}
                          {view.source === '上传' ? ' · 上传' : ''}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className="text-[11px] text-muted-foreground">{asset.views.length} 张</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    )
  }
  // A：沿用现有 5 列方格，封面 + 叠层角标。
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-5">
      <NewTile label="新建素材" onClick={onCreate} />
      {ASSETS.map((asset) => (
        <button
          key={asset.id}
          type="button"
          onClick={() => onOpen(asset)}
          className="group relative aspect-square overflow-hidden rounded-xl border border-border bg-muted text-left transition hover:border-primary"
        >
          <img src={asset.views[0].src} alt="" className="h-full w-full object-cover" />
          <div className="absolute left-1.5 top-1.5 flex gap-1">
            <KindTag asset={asset} />
          </div>
          {asset.views.length > 1 && (
            <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] text-white">
              <Layers className="h-3 w-3" /> {asset.views.length}
            </span>
          )}
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-4">
            <span className="truncate text-[12px] text-white">{asset.name}</span>
            <BgTag asset={asset} />
          </div>
        </button>
      ))}
    </div>
  )
}

function AssetDetail({ asset, onClose }: { asset: ProtoAsset; onClose: () => void }) {
  return (
    <Overlay onClose={onClose}>
      <div className="w-[min(92vw,720px)] rounded-2xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-medium">{asset.name}</h2>
          {asset.kind && (
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px]">{asset.kind}</span>
          )}
          <BgTag asset={asset} />
          <button type="button" className="ml-auto text-xs text-muted-foreground" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {asset.views.map((view, i) => (
            <figure key={i} className="flex flex-col gap-1">
              <img
                src={view.src}
                alt=""
                className="aspect-square rounded-lg border border-border object-cover"
              />
              <figcaption className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  {i === 0 ? '封面 · ' : ''}
                  {view.label}
                </span>
                <span>{view.source}</span>
              </figcaption>
            </figure>
          ))}
          <button
            type="button"
            className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border text-xs text-muted-foreground hover:bg-muted"
          >
            <Plus className="h-4 w-4" /> 追加视角
          </button>
        </div>
      </div>
    </Overlay>
  )
}

/* ---------------- 提示词（旧模板） ---------------- */

function PromptsTab() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {['白底主图 · 通用', '节日促销 · 春节', '包装特写'].map((name) => (
        <div key={name} className="rounded-xl border border-border bg-card p-3">
          <div className="text-[13px] font-medium">{name}</div>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            @图1 放在纯白背景中央，柔和顶光，产品占画面 70%，无文字……
          </p>
          <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span>1:1 · 2 张</span>
            <button type="button" className="ml-auto rounded-md border border-border px-2 py-0.5">
              套用
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/* ---------------- 模板（look） ---------------- */

function PurposeTag({ purpose }: { purpose: Purpose }) {
  return (
    <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${PURPOSE_TONE[purpose]}`}>
      {purpose}
    </span>
  )
}

function LookActions({ look, onBatch }: { look: ProtoLook; onBatch: (l: ProtoLook) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        disabled={look.needsRetune}
        onClick={() => onBatch(look)}
        className="rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-40"
      >
        用它出图
      </button>
      {look.origin === '自建' && (
        <button type="button" className="rounded-md border border-border px-2 py-1 text-[11px]">
          继续调试
        </button>
      )}
    </div>
  )
}

type LookHandlers = {
  onBatch: (l: ProtoLook) => void
  onOpen: (l: ProtoLook) => void
}

/** 网格里的第一格：新建。 */
function NewTile({ label, onClick, tall }: { label: string; onClick: () => void; tall?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex ${tall ? 'aspect-[4/5]' : 'aspect-square'} flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 text-[13px] text-muted-foreground transition hover:border-primary hover:text-foreground`}
    >
      <Plus className="h-7 w-7" />
      {label}
    </button>
  )
}

function LookCard({ look, onBatch, onOpen }: { look: ProtoLook } & LookHandlers) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card transition hover:border-primary">
      <button type="button" onClick={() => onOpen(look)} className="relative aspect-[4/5] bg-muted text-left">
        <img src={look.cover} alt="" className="h-full w-full object-cover" />
        <div className="absolute left-1.5 top-1.5 flex gap-1">
          <PurposeTag purpose={look.purpose} />
          {look.origin === '预置' && (
            <span className="rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] text-white">预置</span>
          )}
        </div>
        {look.needsRetune && (
          <span className="absolute right-1.5 top-1.5 rounded-md bg-warning px-1.5 py-0.5 text-[10px] text-white">
            需重新调试
          </span>
        )}
      </button>
      <div className="flex flex-col gap-1.5 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={() => onOpen(look)} className="truncate text-left text-[13px] font-medium hover:text-primary">
            {look.name}
          </button>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {look.slots} 个素材位
          </span>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {look.model} · {look.size}
        </span>
        <LookActions look={look} onBatch={onBatch} />
      </div>
    </div>
  )
}

function LooksTab({
  variant,
  onBatch,
  onOpen,
  onCreate,
}: { variant: string; onCreate: () => void } & LookHandlers) {
  if (variant === 'B') {
    // B：列表，提示词摘要可见，适合「找那条改过的」。
    return (
      <div className="divide-y divide-border rounded-xl border border-border">
        <button type="button" onClick={onCreate} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] text-muted-foreground hover:bg-muted">
          <Plus className="h-4 w-4" /> 新建模板
        </button>
        {LOOKS.map((look) => (
          <div key={look.id} className="flex items-start gap-3 px-3 py-2.5">
            <button type="button" onClick={() => onOpen(look)} className="shrink-0">
              <img
                src={look.cover}
                alt=""
                className="h-20 w-16 rounded-lg border border-border object-cover"
              />
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => onOpen(look)} className="text-[13px] font-medium hover:text-primary">
                  {look.name}
                </button>
                <PurposeTag purpose={look.purpose} />
                <span className="text-[10px] text-muted-foreground">{look.origin}</span>
                {look.needsRetune && (
                  <span className="rounded-md bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">
                    需重新调试
                  </span>
                )}
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{look.description}</p>
              <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
                <span>
                  {look.model} · {look.size}
                </span>
                <span>{look.slots} 个素材位</span>
                <span>参考图 {look.refs.length}</span>
              </div>
            </div>
            <LookActions look={look} onBatch={onBatch} />
          </div>
        ))}
      </div>
    )
  }
  if (variant === 'C') {
    // C：按用途分栏横向轨道，自建排在预置前面。
    const purposes: Purpose[] = ['主图', '海报', '场景图', '详情图']
    return (
      <div className="flex flex-col gap-6">
        <div className="w-44">
          <NewTile label="新建模板" onClick={onCreate} tall />
        </div>
        {purposes.map((purpose) => {
          const list = LOOKS.filter((l) => l.purpose === purpose).sort((a) =>
            a.origin === '自建' ? -1 : 1,
          )
          if (list.length === 0) return null
          return (
            <section key={purpose}>
              <h2 className="mb-2 flex items-center gap-2 text-xs font-medium">
                <PurposeTag purpose={purpose} />
                <span className="text-muted-foreground">{list.length} 条</span>
              </h2>
              <div className="flex gap-3 overflow-x-auto pb-1">
                {list.map((look) => (
                  <div key={look.id} className="w-44 shrink-0">
                    <LookCard look={look} onBatch={onBatch} onOpen={onOpen} />
                  </div>
                ))}
              </div>
            </section>
          )
        })}
      </div>
    )
  }
  // A：两段网格——自建在上、预置在下。
  const mine = LOOKS.filter((l) => l.origin === '自建')
  const builtin = LOOKS.filter((l) => l.origin === '预置')
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">我的模板 · {mine.length}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <NewTile label="新建模板" onClick={onCreate} tall />
          {mine.map((look) => (
            <LookCard key={look.id} look={look} onBatch={onBatch} onOpen={onOpen} />
          ))}
        </div>
      </section>
      <section>
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">预置模板 · {builtin.length}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {builtin.map((look) => (
            <LookCard key={look.id} look={look} onBatch={onBatch} onOpen={onOpen} />
          ))}
        </div>
      </section>
    </div>
  )
}
