// PROTOTYPE：智能体对话里的「保存卡片」。素材变体与模板变体各三种：
// A = 紧凑卡（缩略图行 + 名字 + 保存）；B = 摊开卡（全部冻结项可见）；C = 摘要卡 + 点开抽屉编辑。
import { Check, X } from 'lucide-react'
import { useState } from 'react'
import Overlay from '../components/Overlay'
import { CARD, CARD_NOTE, CARD_TITLE, DRAFT_FIELD, REPLY, USER_BUBBLE } from '../features/agent/agentStyles'
import { ASSETS, LOOKS, PURPOSE_TONE } from './data'
import { useVariant } from './proto'

const SAVE =
  'rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition disabled:opacity-40'
const NAME_FIELD =
  'min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1 text-xs focus:border-primary focus:outline-none'

const asset = ASSETS[0]
const look = LOOKS[4]

function Bubble({ text }: { text: string }) {
  return <div className={USER_BUBBLE}>{text}</div>
}
function Reply({ text }: { text: string }) {
  return <div className={`${REPLY} break-words`}>{text}</div>
}

/* ---------------- 素材卡 ---------------- */

function AssetSaveCard() {
  const variant = useVariant()
  const [kept, setKept] = useState(() => asset.views.map(() => true))
  const [name, setName] = useState(asset.name)
  const [saved, setSaved] = useState(false)
  const [open, setOpen] = useState(false)
  const count = kept.filter(Boolean).length

  const thumbs = (size: string) => (
    <div className="flex flex-wrap gap-1.5">
      {asset.views.map((view, i) => (
        <button
          key={i}
          type="button"
          disabled={saved}
          onClick={() => setKept((k) => k.map((v, j) => (j === i ? !v : v)))}
          className={`relative overflow-hidden rounded-lg border ${kept[i] ? 'border-border' : 'border-dashed border-border opacity-35'}`}
          title={kept[i] ? '点击去掉' : '点击保留'}
        >
          <img src={view.src} alt="" className={`${size} object-cover`} />
          <span className="absolute inset-x-0 bottom-0 bg-black/55 px-1 text-[10px] text-white">
            {view.label} · {view.source}
          </span>
          {!kept[i] && (
            <X className="absolute right-1 top-1 h-3.5 w-3.5 rounded bg-black/60 text-white" />
          )}
        </button>
      ))}
    </div>
  )

  if (saved)
    return (
      <div className={CARD}>
        <div className={`${CARD_TITLE} flex items-center gap-1.5`}>
          <Check className="h-3.5 w-3.5 text-success" /> 已存为素材：{name}（{count} 张视角，透明底）
        </div>
        <div className={CARD_NOTE}>在「资产 › 素材」里可以改名、追加视角。</div>
      </div>
    )

  if (variant === 'C')
    return (
      <>
        <div className={CARD}>
          <div className="flex items-center gap-2">
            <img src={asset.views[0].src} alt="" className="h-12 w-12 rounded-lg border border-border" />
            <div className="min-w-0 flex-1">
              <div className={CARD_TITLE}>存为素材：{name}</div>
              <div className={CARD_NOTE}>产品 · {count} 张视角 · 透明底</div>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-border px-3 py-1.5 text-xs">
              查看 / 调整
            </button>
            <button type="button" onClick={() => setSaved(true)} className={SAVE}>
              保存
            </button>
          </div>
        </div>
        {open && (
          <Overlay onClose={() => setOpen(false)}>
            <div className="w-[min(92vw,560px)] rounded-2xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">名字</span>
                <input value={name} onChange={(e) => setName(e.target.value)} className={NAME_FIELD} />
              </div>
              {thumbs('h-24 w-24')}
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-border px-3 py-1.5 text-xs">
                  关闭
                </button>
                <button type="button" onClick={() => { setSaved(true); setOpen(false) }} className={SAVE}>
                  保存 {count} 张
                </button>
              </div>
            </div>
          </Overlay>
        )}
      </>
    )

  return (
    <div className={CARD}>
      <div className={CARD_TITLE}>这组可以存为素材了</div>
      {thumbs(variant === 'B' ? 'h-20 w-20' : 'h-14 w-14')}
      {variant === 'B' && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
          <dt className="text-muted-foreground">类别</dt>
          <dd>产品</dd>
          <dt className="text-muted-foreground">背景</dt>
          <dd>透明底（gpt-image 原生）</dd>
          <dt className="text-muted-foreground">视角</dt>
          <dd>拼图、正面、细节 + 1 张上传原图</dd>
        </dl>
      )}
      <div className="flex items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} className={NAME_FIELD} />
        <button type="button" onClick={() => setSaved(true)} disabled={count === 0} className={SAVE}>
          保存 {count} 张
        </button>
      </div>
      <div className={CARD_NOTE}>点缩略图可以去掉不要的；保存后还能在素材页追加视角。</div>
    </div>
  )
}

/* ---------------- 模板卡 ---------------- */

function LookSaveCard() {
  const variant = useVariant()
  const [name, setName] = useState(look.name)
  const [prompt, setPrompt] = useState(look.prompt)
  const [saved, setSaved] = useState(false)
  const [open, setOpen] = useState(false)

  const meta = (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
      <dt className="text-muted-foreground">用途</dt>
      <dd>
        <span className={`rounded px-1 ${PURPOSE_TONE[look.purpose]}`}>{look.purpose}</span>
      </dd>
      <dt className="text-muted-foreground">模型</dt>
      <dd>
        {look.model} · {look.size}（钉死）
      </dd>
      <dt className="text-muted-foreground">素材位</dt>
      <dd>{look.slots} 个</dd>
      <dt className="text-muted-foreground">封面</dt>
      <dd>暂用参考图，试效果后换成你认定的那张</dd>
    </dl>
  )

  if (saved)
    return (
      <>
        <div className={CARD}>
          <div className={`${CARD_TITLE} flex items-center gap-1.5`}>
            <Check className="h-3.5 w-3.5 text-success" /> 已存为模板：{name}
          </div>
          <div className={CARD_NOTE}>在「资产 › 模板」里可以继续调试或用它出图。</div>
        </div>
        <Reply text="要不要现在拿一条素材试试效果？在输入框里 @ 一条产品素材发给我就行；不满意我们接着改，改好后我会更新这条模板并把你认定的那张设为封面。" />
      </>
    )

  if (variant === 'C')
    return (
      <>
        <div className={CARD}>
          <div className="flex items-center gap-2">
            <img src={look.refs[0]} alt="" className="h-14 w-11 rounded-lg border border-border object-cover" />
            <div className="min-w-0 flex-1">
              <div className={CARD_TITLE}>存为模板：{name}</div>
              <div className={CARD_NOTE}>
                {look.purpose} · {look.model} · {look.size} · {look.slots} 个素材位
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-border px-3 py-1.5 text-xs">
              查看提示词 / 调整
            </button>
            <button type="button" onClick={() => setSaved(true)} className={SAVE}>
              保存
            </button>
          </div>
        </div>
        {open && (
          <Overlay onClose={() => setOpen(false)}>
            <div className="w-[min(92vw,640px)] rounded-2xl border border-border bg-card p-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">名字</span>
                <input value={name} onChange={(e) => setName(e.target.value)} className={NAME_FIELD} />
              </div>
              <div className="flex gap-3">
                <img src={look.refs[0]} alt="" className="h-40 w-32 rounded-lg border border-border object-cover" />
                <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={7} className={DRAFT_FIELD} />
              </div>
              <div className="mt-3">{meta}</div>
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-border px-3 py-1.5 text-xs">
                  关闭
                </button>
                <button type="button" onClick={() => { setSaved(true); setOpen(false) }} className={SAVE}>
                  保存
                </button>
              </div>
            </div>
          </Overlay>
        )}
      </>
    )

  return (
    <div className={CARD}>
      <div className={CARD_TITLE}>提示词调好了，可以存为模板</div>
      <div className="flex gap-2">
        <img src={look.refs[0]} alt="" className={`${variant === 'B' ? 'h-32 w-24' : 'h-20 w-16'} shrink-0 rounded-lg border border-border object-cover`} />
        {variant === 'B' ? (
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={6} className={DRAFT_FIELD} />
        ) : (
          <p className="line-clamp-4 text-[11px] leading-relaxed text-muted-foreground">{prompt}</p>
        )}
      </div>
      {variant === 'B' ? meta : (
        <div className={CARD_NOTE}>
          {look.purpose} · {look.model} · {look.size} · {look.slots} 个素材位 · 封面暂用参考图
        </div>
      )}
      <div className="flex items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} className={NAME_FIELD} />
        <button type="button" onClick={() => setSaved(true)} className={SAVE}>
          保存
        </button>
      </div>
    </div>
  )
}

/* ---------------- 假对话 ---------------- */

/** 注入到对话面板消息列表末尾的两段假对话：创建素材 → 保存卡；创建模板 → 保存卡。 */
export default function SaveCardPrototype() {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="my-2 text-center text-[10px] uppercase tracking-wider text-fuchsia-500">
        ↓ prototype：保存卡片 ↓
      </div>
      <Bubble text="/create-asset 这是我的浴缸，帮我做一套素材" />
      <Reply text="收到 1 张实拍图。我按它生成了一张正 / 侧 / 背拼图（透明底），又拆出正面和排水口细节两张。看一下，没问题就存：" />
      <AssetSaveCard />
      <Bubble text="/create-look 我想要这种效果 [参考海报]" />
      <Reply text="看过参考图了。反推出来的提示词按「主体位 / 环境 / 光线 / 构图 / 风格 / 禁止项」写好，主体那段留给素材。你可以直接改，改完存：" />
      <LookSaveCard />
    </div>
  )
}
