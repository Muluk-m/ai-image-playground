import {
  ArrowRight,
  Bell,
  ChevronDown,
  Compass,
  FolderOpen,
  Heart,
  ImageIcon,
  Layers,
  LayoutGrid,
  Plus,
  Settings2,
  Sparkles,
  Sun,
  Zap,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'

/** throwaway：去掉顶栏之后的外壳两版。只画壳，不接 store。 */

type Shell = 'rail' | 'jimeng'

const SHELLS: Record<Shell, { label: string; note: string }> = {
  rail: {
    label: '① 图标轨 + 首屏大图',
    note: '你贴的那版：56px 图标轨、无顶栏、账号与积分浮在右上、首屏一张氛围底图，composer 是主角。',
  },
  jimeng: {
    label: '② 即梦式：文字侧栏 + 会话列表',
    note: '208px 文字侧栏（品牌在栏内、可收起），下面接最近会话与画布；主区无顶栏，积分/会员浮在右上。',
  },
}

const LOCAL = [
  '/cases/serum-macro.webp',
  '/cases/sneaker-turntable.webp',
  '/cases/unboxing-apparel.webp',
  '/cases/perfume-pedestal-up.webp',
]

const WORKS = [
  { title: '山间的未来建筑', author: '幕芽官方', likes: 234 },
  { title: '自然的细微之美', author: '灵感用户', likes: 189 },
  { title: '光影与空间', author: '创意研究所', likes: 321 },
  { title: '流动的想象', author: '幕芽实验室', likes: 278 },
]

const SKILLS = ['商品主图 · 白底', '节日海报', '角色三视图', '换背景']

function useThumbs() {
  const [thumbs, setThumbs] = useState<string[]>(
    Array.from({ length: 4 }, (_, at) => `${LOCAL[at % LOCAL.length]}#${at}`),
  )
  useEffect(() => {
    void fetch('/inspiration-manifest.json')
      .then((response) => response.json())
      .then((list: { thumbnailUrl: string }[]) => {
        if (list.length) setThumbs(list.slice(0, 4).map((one) => one.thumbnailUrl))
      })
      .catch(() => undefined)
  }, [])
  return thumbs
}

/** 首屏氛围底图：纯 CSS，不加图片资源。 */
const HERO_BACKDROP: React.CSSProperties = {
  background:
    'radial-gradient(900px 520px at 62% -28%, hsl(var(--primary) / 0.28), transparent 62%),' +
    'radial-gradient(520px 320px at 12% 6%, hsl(var(--primary) / 0.10), transparent 70%),' +
    'radial-gradient(1200px 700px at 50% -40%, rgba(255,255,255,0.05), transparent 65%)',
}

function FloatingAccount() {
  return (
    <div className="pointer-events-auto absolute right-5 top-4 z-10 flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-full border border-border bg-card/80 px-3 py-1.5 text-[13px] backdrop-blur-sm">
          <Zap className="h-3.5 w-3.5 text-primary" />
          583,850
        </span>
        <button
          type="button"
          className="grid h-8 w-8 place-items-center rounded-full border border-border bg-card/80 text-muted-foreground backdrop-blur-sm"
        >
          <Bell className="h-4 w-4" />
        </button>
        <span
          className="grid h-8 w-8 place-items-center rounded-full text-xs font-semibold text-black"
          style={{ background: 'linear-gradient(140deg, #f7d774, #d9a441)' }}
        >
          M
        </span>
      </div>
    </div>
  )
}

function Rail() {
  const items = [
    { label: '创作', icon: Sparkles, active: true },
    { label: '探索', icon: Compass },
    { label: '项目', icon: Layers },
    { label: '资产', icon: FolderOpen },
  ]
  return (
    <nav
      style={{ width: 62 }}
      className="flex shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-3"
    >
      <span
        className="mb-2 grid h-8 w-8 place-items-center rounded-xl text-sm font-bold text-primary-foreground"
        style={{
          background: 'linear-gradient(140deg, hsl(var(--primary)), hsl(var(--primary) / 0.6))',
        }}
      >
        幕
      </span>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={`flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-xl text-[10px] transition-colors ${
            item.active
              ? 'bg-accent font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          <item.icon className={`h-4 w-4 ${item.active ? 'text-primary' : ''}`} />
          {item.label}
        </button>
      ))}
      <div className="mt-auto flex w-full flex-col items-center gap-1">
        <span className="mb-1 h-px w-7 bg-border" />
        <button
          type="button"
          className="flex h-12 w-12 flex-col items-center justify-center gap-0.5 rounded-xl text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <FolderOpen className="h-4 w-4" />
          我的资产
        </button>
        <button
          type="button"
          className="grid h-10 w-10 place-items-center rounded-xl text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Sun className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="mt-1 grid h-9 w-9 place-items-center rounded-full text-[11px] font-semibold text-black"
          style={{
            background: 'linear-gradient(140deg, #d9ffba, #8fe06a)',
            boxShadow: '0 0 0 2px hsl(var(--sidebar)), 0 0 18px -4px rgba(143,224,106,0.8)',
          }}
        >
          幕
        </button>
      </div>
    </nav>
  )
}

function LabelSidebar() {
  const items = [
    { label: '创作', icon: Sparkles, active: true },
    { label: '探索', icon: Compass },
    { label: '项目', icon: Layers },
    { label: '资产', icon: FolderOpen },
  ]
  return (
    <nav
      style={{ width: 208 }}
      className="flex shrink-0 flex-col gap-1 border-r border-border bg-sidebar px-2.5 py-3"
    >
      <div className="flex items-center gap-2 px-1.5 pb-3">
        <span
          className="grid h-7 w-7 place-items-center rounded-lg text-xs font-bold text-primary-foreground"
          style={{
            background: 'linear-gradient(140deg, hsl(var(--primary)), hsl(var(--primary) / 0.6))',
          }}
        >
          幕
        </span>
        <span className="text-[15px] font-semibold">幕芽 Muvloom</span>
      </div>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={`flex h-10 items-center gap-2.5 rounded-xl px-3 text-[13px] transition-colors ${
            item.active
              ? 'bg-accent font-medium text-foreground'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'
          }`}
        >
          <item.icon className={`h-4 w-4 ${item.active ? 'text-primary' : ''}`} />
          {item.label}
        </button>
      ))}
      <p className="px-3 pb-1 pt-4 text-[10px] font-semibold tracking-[0.16em] text-muted-foreground">
        最近画布
      </p>
      {['浴室系列', '猫咪广告 30s', '香水主图'].map((name) => (
        <button
          key={name}
          type="button"
          className="flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ImageIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{name}</span>
        </button>
      ))}
      <button
        type="button"
        className="mt-auto flex items-center gap-2 rounded-xl border border-border p-2.5 text-left"
        style={{
          background:
            'linear-gradient(135deg, hsl(var(--primary) / 0.16), hsl(var(--primary) / 0.03) 60%, transparent)',
        }}
      >
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[11px] font-bold text-black"
          style={{ background: 'linear-gradient(140deg, #f7d774, #d9a441)' }}
        >
          VIP
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">升级会员</span>
          <span className="block truncate text-[11px] text-muted-foreground">解锁更多创作能力</span>
        </span>
        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
    </nav>
  )
}

function ModeSwitch() {
  return (
    <div className="mx-auto flex w-fit items-center gap-1 rounded-full border border-border bg-card/70 p-1 backdrop-blur-sm">
      <button
        type="button"
        className="rounded-full px-10 py-2.5 text-[14px] font-medium text-black"
        style={{
          background: 'linear-gradient(135deg, #d6ffb4, #8fe06a 55%, #5fbf52)',
          boxShadow:
            '0 0 0 1px rgba(255,255,255,0.22) inset, 0 10px 34px -10px rgba(143,224,106,0.85)',
        }}
      >
        创作
      </button>
      <button type="button" className="rounded-full px-10 py-2.5 text-[14px] text-muted-foreground">
        画布
      </button>
    </div>
  )
}

function BigComposer() {
  return (
    <div
      className="rounded-3xl border border-border p-4"
      style={{
        background: 'linear-gradient(180deg, hsl(var(--card) / 0.92), hsl(var(--card) / 0.72))',
        boxShadow: '0 40px 90px -50px hsl(var(--primary) / 0.7)',
        backdropFilter: 'blur(10px)',
      }}
    >
      <div className="flex items-start gap-3">
        <textarea
          rows={2}
          placeholder="说一句你想做什么，@ 引用画布或素材"
          className="min-h-0 flex-1 resize-none bg-transparent pt-1 text-[15px] outline-none placeholder:text-muted-foreground"
        />
        <div className="flex shrink-0 items-center gap-1.5">
          {[Sparkles, Settings2].map((Icon, at) => (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: 原型里的一排装饰按钮
              key={at}
              type="button"
              className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted-foreground"
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-3">
        {[
          { label: '添加素材', icon: Plus },
          { label: '引用画布', icon: Layers },
          { label: '参考图', icon: ImageIcon },
          { label: '模板', icon: LayoutGrid },
        ].map((one) => (
          <button
            key={one.label}
            type="button"
            className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-[13px] text-muted-foreground"
          >
            <one.icon className="h-3.5 w-3.5" />
            {one.label}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {['模型 Image 2.5 Flare', '比例 16:9', '数量 1'].map((chip) => (
          <span
            key={chip}
            className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-[13px] text-muted-foreground"
          >
            {chip}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </span>
        ))}
        <button
          type="button"
          className="ml-auto flex items-center gap-2 rounded-full px-9 py-3 text-[15px] font-medium text-black"
          style={{
            background: 'linear-gradient(135deg, #d9ffba, #93e46f 55%, #63c455)',
            boxShadow:
              '0 0 0 1px rgba(255,255,255,0.25) inset, 0 14px 44px -12px rgba(147,228,111,0.95)',
          }}
        >
          <Zap className="h-4 w-4" />
          立即生成
        </button>
      </div>
    </div>
  )
}

function SkillChips({ thumbs }: { thumbs: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 pt-4">
      {SKILLS.map((skill, at) => (
        <button
          key={skill}
          type="button"
          className="flex items-center gap-2 rounded-xl border border-border bg-card/70 py-1.5 pl-1.5 pr-3.5 text-[13px] text-muted-foreground backdrop-blur-sm transition-colors hover:border-primary/50 hover:text-foreground"
        >
          <img
            src={thumbs[at % thumbs.length]}
            alt=""
            className="h-7 w-10 rounded-lg object-cover"
          />
          {skill}
        </button>
      ))}
      <button
        type="button"
        className="flex items-center gap-1 rounded-xl border border-border px-3.5 py-2.5 text-[13px] text-muted-foreground"
      >
        更多灵感
        <ArrowRight className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function WorkGrid({ thumbs }: { thumbs: string[] }) {
  return (
    <>
      <div className="flex items-center gap-3 pb-3 pt-8">
        <h2 className="text-[15px] font-semibold">灵感作品</h2>
        <div className="flex items-center gap-1">
          {['推荐', '我收藏的', '我的作品'].map((tab, at) => (
            <button
              key={tab}
              type="button"
              className={`rounded-full px-3 py-1 text-[13px] ${
                at === 0
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>
        <button type="button" className="ml-auto text-xs text-muted-foreground">
          查看全部 →
        </button>
      </div>
      <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))' }}>
        {WORKS.map((work, at) => (
          <article
            key={work.title}
            className="group overflow-hidden rounded-2xl border border-border bg-card"
          >
            <img
              src={thumbs[at % thumbs.length]}
              alt=""
              className="aspect-[4/3] w-full object-cover"
            />
            <div className="flex items-center gap-2 px-3 py-2.5">
              <span className="h-5 w-5 shrink-0 rounded-full bg-muted" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{work.title}</p>
                <p className="truncate text-[11px] text-muted-foreground">{work.author}</p>
              </div>
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                <Heart className="h-3.5 w-3.5" />
                {work.likes}
              </span>
            </div>
          </article>
        ))}
      </div>
    </>
  )
}

const HEROES = [
  'CSS 渐变',
  '1 行星',
  '2 强光',
  '3 极光环',
  '4 极光带',
  '5 暗星球',
  '6 暗星球+环',
  '7 极暗',
  '8 星球(压暗)',
  '9 藤蔓角',
  '10 嫩叶角',
]

export default function UiShell() {
  const [shell, setShell] = useState<Shell>('jimeng')
  const [hero, setHero] = useState(8)
  const thumbs = useThumbs()

  return (
    <div className="flex flex-col" style={{ height: '100vh' }}>
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <span className="text-sm font-semibold">无顶栏外壳 · 两版</span>
        <div className="flex gap-1">
          {HEROES.map((label, at) => (
            <button
              key={label}
              type="button"
              onClick={() => setHero(at)}
              className={`rounded-full px-2.5 py-1 text-[11px] ${
                hero === at
                  ? 'bg-accent font-medium text-foreground'
                  : 'border border-border text-muted-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-1.5">
          {(Object.keys(SHELLS) as Shell[]).map((one) => (
            <button
              key={one}
              type="button"
              onClick={() => setShell(one)}
              className={`rounded-full px-3 py-1 text-xs ${
                shell === one
                  ? 'bg-primary font-medium text-primary-foreground'
                  : 'border border-border text-muted-foreground'
              }`}
            >
              {SHELLS[one].label}
            </button>
          ))}
        </div>
      </div>
      <p className="shrink-0 border-b border-border bg-muted/30 px-4 py-1.5 text-xs text-muted-foreground">
        {SHELLS[shell].note}
      </p>

      <div className="flex min-h-0 flex-1">
        {shell === 'rail' ? <Rail /> : <LabelSidebar />}
        <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div
            className="pointer-events-none absolute inset-x-0 top-0"
            style={
              hero === 0
                ? { height: 520, ...HERO_BACKDROP }
                : {
                    height: 620,
                    backgroundImage: `linear-gradient(to bottom, transparent 55%, hsl(var(--background))), url(/hero/hero-${hero}.webp)`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'top center',
                  }
            }
          />
          <FloatingAccount />
          <div className="relative mx-auto w-full max-w-5xl px-8 pb-12 pt-14">
            <h1 className="text-center text-[40px] font-semibold leading-tight tracking-tight">
              用想象，
              <span
                style={{
                  background: 'linear-gradient(100deg, #eaffd6, #a6ef7c 45%, #6fd36a)',
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                  textShadow: '0 0 38px rgba(150,230,110,0.35)',
                }}
              >
                创造更多可能
              </span>
            </h1>
            <p className="pb-5 pt-2 text-center text-sm text-muted-foreground">
              在幕芽 Muvloom，把灵感变成看得见的作品
            </p>
            <div className="pb-5">
              <ModeSwitch />
            </div>
            <BigComposer />
            <SkillChips thumbs={thumbs} />
            <WorkGrid thumbs={thumbs} />
          </div>
        </main>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<UiShell />)
