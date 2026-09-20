import {
  ArrowRight,
  Compass,
  Crown,
  FolderOpen,
  ImageIcon,
  Layers,
  Search,
  Sparkles,
  Star,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'

/** throwaway：创作·生成页的三版视觉。只画壳，不接 store。 */

type Variant = 'A' | 'B' | 'C'

const VARIANTS: Record<Variant, { label: string; note: string }> = {
  A: {
    label: 'A 门户式',
    note: '大标题 + 风格快筛 + 卡片带标题/副标题与进入箭头，底部一条发光 composer。最接近你给的参考。',
  },
  B: {
    label: 'B 工作台式',
    note: '不要大标题，一行工具条吃掉筛选与模式；卡片更密更小，屏幕都留给内容。适合每天来十次的人。',
  },
  C: {
    label: 'C 舞台式',
    note: 'composer 提到正上方当主角（一进来就写），灵感在下面铺开。新用户最快上手，老用户要多滚一屏看作品。',
  },
}

const LOCAL = [
  '/cases/serum-macro.webp',
  '/cases/sneaker-turntable.webp',
  '/cases/unboxing-apparel.webp',
  '/cases/perfume-pedestal-up.webp',
  '/auth/login-sky.webp',
]

const META = [
  { title: '手机爆炸拆解图', sub: '科技产品结构拆解 · 信息可视化', tag: '图表与信息图' },
  { title: '雨夜便利店 · 电影感', sub: '一个人的城市，雨夜的氛围感', tag: '场景与叙事' },
  { title: '春日花田三联竖版写真', sub: '清新自然 · 人像写真', tag: '摄影与写实' },
  { title: '品牌视觉识别图', sub: '黑白漫画 · 叙事分镜', tag: '插画与艺术' },
  { title: '极简建筑地标海报', sub: '建筑美学 · 极简设计', tag: '建筑与空间' },
  { title: '草莓能量饮料广告', sub: '商业静物 · 高饱和', tag: '产品与电商' },
]

const STYLES = ['摄影', '插画', '建筑', '海报', '产品', '电影感']

function useThumbs() {
  const [thumbs, setThumbs] = useState<string[]>(
    Array.from({ length: 6 }, (_, at) => `${LOCAL[at % LOCAL.length]}#${at}`),
  )
  useEffect(() => {
    void fetch('/inspiration-manifest.json')
      .then((response) => response.json())
      .then((list: { thumbnailUrl: string }[]) => {
        if (list.length) setThumbs(list.slice(0, 6).map((one) => one.thumbnailUrl))
      })
      .catch(() => undefined)
  }, [])
  return thumbs
}

/** 侧栏底部的会员位：等级 + 本月额度 + 升级入口。 */
function MemberCard({ dense }: { dense?: boolean }) {
  return (
    <button
      type="button"
      className="group mt-auto w-full rounded-xl border border-border p-2.5 text-left transition-colors hover:border-primary/60"
      style={{
        background:
          'linear-gradient(135deg, hsl(var(--primary) / 0.16), hsl(var(--primary) / 0.03) 60%, transparent)',
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
          style={{ background: 'linear-gradient(140deg, #f7d774, #d9a441)' }}
        >
          <Crown className="h-4 w-4 text-black/80" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-foreground">升级会员</p>
          {!dense && <p className="truncate text-[11px] text-muted-foreground">解锁更多创作能力</p>}
        </div>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>
      {!dense && (
        <div className="pt-2">
          <div className="flex items-center justify-between pb-1 text-[10px] text-muted-foreground">
            <span>免费版 · 本月额度</span>
            <span>1,240 / 2,000</span>
          </div>
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{ width: '62%', background: 'linear-gradient(90deg, #f7d774, #d9a441)' }}
            />
          </div>
        </div>
      )}
    </button>
  )
}

function Nav({ dense }: { dense?: boolean }) {
  const items = [
    { label: '创作', icon: ImageIcon, active: true },
    { label: '探索', icon: Compass },
    { label: '项目', icon: Layers },
    { label: '资产', icon: FolderOpen },
  ]
  return (
    <nav
      style={{ width: 208 }}
      className="flex shrink-0 flex-col gap-1 border-r border-border bg-sidebar px-2.5 py-3"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={`flex h-10 w-full items-center gap-2.5 rounded-xl px-3 text-[13px] transition-colors ${
            item.active
              ? 'bg-accent font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
          style={
            item.active ? { boxShadow: 'inset 0 0 0 1px hsl(var(--primary) / 0.35)' } : undefined
          }
        >
          <item.icon className={`h-4 w-4 ${item.active ? 'text-primary' : ''}`} />
          {item.label}
        </button>
      ))}
      <MemberCard dense={dense} />
    </nav>
  )
}

function ModeSwitch({ big }: { big?: boolean }) {
  return (
    <div className="flex items-center gap-1 rounded-full border border-border bg-muted p-1">
      <button
        type="button"
        className={`rounded-full ${big ? 'px-7 py-2' : 'px-4 py-1'} text-[13px] font-medium text-primary-foreground`}
        style={{
          background: 'linear-gradient(120deg, hsl(var(--primary)), hsl(var(--primary) / 0.75))',
        }}
      >
        生成
      </button>
      <button
        type="button"
        className={`rounded-full ${big ? 'px-7 py-2' : 'px-4 py-1'} text-[13px] text-muted-foreground`}
      >
        画布
      </button>
    </div>
  )
}

function Card({
  src,
  meta,
  compact,
}: {
  src: string
  meta: (typeof META)[number]
  compact?: boolean
}) {
  return (
    <article className="group overflow-hidden rounded-2xl border border-border bg-card transition-colors hover:border-primary/50">
      <div className="relative">
        <img
          src={src}
          alt=""
          className={`w-full object-cover ${compact ? 'aspect-square' : 'aspect-[4/3]'}`}
        />
        <span className="absolute left-2.5 top-2.5 rounded-lg bg-black/55 px-2 py-0.5 text-[10px] text-white backdrop-blur-sm">
          {meta.tag}
        </span>
        <span className="absolute right-2.5 top-2.5 grid h-7 w-7 place-items-center rounded-lg bg-black/45 text-white/90 opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          <Star className="h-3.5 w-3.5" />
        </span>
      </div>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{meta.title}</p>
          {!compact && <p className="truncate text-[11px] text-muted-foreground">{meta.sub}</p>}
        </div>
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
          <ArrowRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </article>
  )
}

function Composer({ glow, hero }: { glow?: boolean; hero?: boolean }) {
  return (
    <div
      className="rounded-2xl p-[1.5px]"
      style={
        glow
          ? {
              background:
                'linear-gradient(120deg, hsl(var(--primary) / 0.75), hsl(var(--primary) / 0.15) 45%, transparent)',
              boxShadow: '0 24px 60px -32px hsl(var(--primary) / 0.55)',
            }
          : { background: 'hsl(var(--border))' }
      }
    >
      <div className="rounded-[15px] bg-card p-3">
        <div className="flex items-start gap-3">
          <button
            type="button"
            className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-dashed border-border text-muted-foreground"
          >
            <ImageIcon className="h-4 w-4" />
          </button>
          <textarea
            rows={hero ? 3 : 2}
            placeholder="描述你想生成的图片，@ 指定参考图，{槽位} 批量生成..."
            className="min-h-0 flex-1 resize-none bg-transparent pt-1 text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground"
          >
            <Sparkles className="h-3.5 w-3.5" />
            灵感提示
          </button>
        </div>
        <div className="flex items-center gap-2 pt-2.5">
          {['尺寸 auto', '数量 1', '风格 不限定', '更多'].map((chip) => (
            <span
              key={chip}
              className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground"
            >
              {chip}
            </span>
          ))}
          <button
            type="button"
            className="ml-auto flex items-center gap-1.5 rounded-full px-5 py-2 text-[13px] font-medium text-primary-foreground"
            style={{
              background: 'linear-gradient(120deg, hsl(var(--primary)), hsl(var(--primary) / 0.7))',
            }}
          >
            <Sparkles className="h-4 w-4" />
            生成
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

function SearchRow({ styles }: { styles?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 pb-5">
      <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border border-border px-3">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          placeholder="搜索提示词、参数或灵感..."
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
      </label>
      {styles &&
        STYLES.map((style) => (
          <span
            key={style}
            className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground"
          >
            {style}
          </span>
        ))}
    </div>
  )
}

export default function UiDemo() {
  const [variant, setVariant] = useState<Variant>('A')
  const thumbs = useThumbs()
  const cards = thumbs.map((src, at) => ({ src, meta: META[at % META.length]! }))

  return (
    <div className="flex flex-col" style={{ height: '100vh' }}>
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <span className="text-sm font-semibold">创作 · 生成页视觉三版</span>
        <div className="ml-auto flex gap-1.5">
          {(Object.keys(VARIANTS) as Variant[]).map((one) => (
            <button
              key={one}
              type="button"
              onClick={() => setVariant(one)}
              className={`rounded-full px-3 py-1 text-xs ${
                variant === one
                  ? 'bg-primary font-medium text-primary-foreground'
                  : 'border border-border text-muted-foreground'
              }`}
            >
              {VARIANTS[one].label}
            </button>
          ))}
        </div>
      </div>
      <p className="shrink-0 border-b border-border bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">
        {VARIANTS[variant].note}
      </p>

      <div className="flex min-h-0 flex-1">
        <Nav dense={variant === 'B'} />
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {variant === 'A' && (
            <div className="mx-auto w-full max-w-6xl px-7 py-6">
              <div className="flex items-start gap-4 pb-5">
                <div className="min-w-0 flex-1">
                  <h1 className="text-[28px] font-semibold leading-tight">
                    用想象，生成<span className="text-primary">更多可能</span>
                  </h1>
                  <p className="pt-1.5 text-sm text-muted-foreground">
                    从灵感开始，输入文字，生成你想要的图像
                  </p>
                </div>
                <ModeSwitch big />
              </div>
              <SearchRow styles />
              <div className="flex items-baseline gap-2 pb-3">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-primary">
                  <Sparkles className="h-4 w-4" />
                  灵感探索
                </h2>
                <span className="text-xs text-muted-foreground">发现更多创作灵感</span>
                <button type="button" className="ml-auto text-xs text-muted-foreground">
                  查看全部 →
                </button>
              </div>
              <div
                className="grid gap-3.5"
                style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}
              >
                {cards.map((card) => (
                  <Card key={card.src} {...card} />
                ))}
              </div>
              <div className="pt-6">
                <Composer glow />
              </div>
            </div>
          )}

          {variant === 'B' && (
            <div className="mx-auto w-full max-w-6xl px-7 py-5">
              <div className="flex items-center gap-2 pb-4">
                <ModeSwitch />
                <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border border-border px-3">
                  <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <input
                    placeholder="搜索提示词、参数..."
                    className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                </label>
                {STYLES.slice(0, 4).map((style) => (
                  <span
                    key={style}
                    className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground"
                  >
                    {style}
                  </span>
                ))}
              </div>
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr))' }}
              >
                {cards.map((card) => (
                  <Card key={card.src} {...card} compact />
                ))}
              </div>
              <div className="pt-5">
                <Composer />
              </div>
            </div>
          )}

          {variant === 'C' && (
            <div className="mx-auto w-full max-w-4xl px-7 py-8">
              <div className="flex flex-col items-center gap-4 pb-6">
                <h1 className="text-[26px] font-semibold">今天想生成点什么</h1>
                <ModeSwitch big />
              </div>
              <Composer glow hero />
              <div className="flex items-baseline gap-2 pb-3 pt-8">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-primary">
                  <Sparkles className="h-4 w-4" />
                  灵感探索
                </h2>
                <button type="button" className="ml-auto text-xs text-muted-foreground">
                  查看全部 →
                </button>
              </div>
              <div
                className="grid gap-3.5"
                style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}
              >
                {cards.map((card) => (
                  <Card key={card.src} {...card} />
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<UiDemo />)
