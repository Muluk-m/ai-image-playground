// PROTOTYPE — throwaway。变体 D「工具目录 · 精修」：结构同 A（一个功能一个入口，进去只做这一件事），
// 只重做布局与质感。首页是带示意图的工具卡 + 顶部收图条；进入工具后三栏：左侧工具栏随时切换，
// 中间图片舞台（点图看前后对比），右侧该工具专属的设置面板，结果合计与下载钉在面板底部。
// 取舍同 A：入口最好懂；多步处理要切多个工具（左侧栏让切换只需一下）。

import {
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Crop,
  Download,
  FlipHorizontal2,
  FlipVertical2,
  FolderOpen,
  GalleryVertical,
  Grid3x3,
  ImagePlus,
  LayoutGrid,
  Loader2,
  Minimize2,
  RotateCw,
  Scaling,
  SquareArrowOutUpRight,
  X,
} from 'lucide-react'
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { Button } from '../../../components/ui/button'
import { downloadBlob } from '../../../lib/downloadImages'
import { APP_MODE_LABELS } from '../../../store'
import {
  type ComposeOptions,
  DEFAULT_RECIPE,
  downloadAll,
  formatBytes,
  type OutputFormat,
  outputName,
  type Recipe,
  savingLabel,
} from './ops'
import { type ImageIntake, NumberField, ResultBadges, sendToCreate, useIntake } from './shared'
import {
  doneEntries,
  type ProtoItem,
  type ResultState,
  totalBytes,
  useComposed,
  useProcessed,
  useProto,
} from './state'

type ProcessTool = 'compress' | 'convert' | 'resize' | 'crop' | 'rotate'
type ComposeTool = 'collage' | 'stitch' | 'slice'
type ToolId = ProcessTool | ComposeTool

const TOOLS: Record<
  ToolId,
  { name: string; desc: string; icon: ComponentType<{ className?: string }> }
> = {
  compress: { name: '压缩', desc: '减小文件体积', icon: Minimize2 },
  convert: { name: '转格式', desc: '常见格式互转', icon: ArrowRightLeft },
  resize: { name: '改尺寸', desc: '按长边或比例缩放', icon: Scaling },
  crop: { name: '裁剪', desc: '按比例或平台规格', icon: Crop },
  rotate: { name: '旋转翻转', desc: '旋转与镜像', icon: RotateCw },
  collage: { name: '拼图', desc: '多张合成宫格图', icon: LayoutGrid },
  stitch: { name: '长图拼接', desc: '纵向或横向拼接', icon: GalleryVertical },
  slice: { name: '九宫格切图', desc: '切分为等分格图', icon: Grid3x3 },
}

const PROCESS_TOOLS: readonly ProcessTool[] = ['compress', 'convert', 'resize', 'crop', 'rotate']
const COMPOSE_TOOLS: readonly ComposeTool[] = ['collage', 'stitch', 'slice']
const isCompose = (tool: ToolId): tool is ComposeTool =>
  (COMPOSE_TOOLS as readonly ToolId[]).includes(tool)

/** 每件工具只读配方里属于自己的字段，其余按默认：进「压缩」不会顺带把上次的裁剪也做了。 */
const TOOL_FIELDS: Record<ProcessTool, readonly (keyof Recipe)[]> = {
  compress: ['format', 'compressMode', 'quality', 'targetKb'],
  convert: ['format', 'quality'],
  resize: ['resizeMode', 'resizeValue'],
  crop: ['crop', 'cropX', 'cropY'],
  rotate: ['rotate', 'flipH', 'flipV'],
}

const CHECKER =
  'bg-[repeating-conic-gradient(hsl(var(--secondary))_0%_25%,transparent_0%_50%)] bg-[length:14px_14px]'

export default function VariantD() {
  const [tool, setTool] = useState<ToolId | null>(null)
  return tool ? (
    <ToolView tool={tool} onPick={setTool} onBack={() => setTool(null)} />
  ) : (
    <Catalog onPick={setTool} />
  )
}

// 首页与工具页各自调用 useIntake；用一个轻量 context 把它递给深处的收图条与空舞台。
const IntakeContext = createContext<ImageIntake | null>(null)
function useIntakeContext() {
  const intake = useContext(IntakeContext)
  if (!intake) throw new Error('IntakeContext missing')
  return intake
}

// ================================================================ 首页

function ToolArt({ tool }: { tool: ToolId }) {
  const cell = 'rounded-[3px] bg-primary/30'
  switch (tool) {
    case 'compress':
      return (
        <div className="flex items-center gap-2 text-[11px] tabular-nums">
          <span className="rounded-md bg-background/70 px-2 py-1 text-muted-foreground line-through">
            2.4 MB
          </span>
          <ArrowRight className="h-3 w-3 text-muted-foreground" />
          <span className="rounded-md bg-primary/15 px-2 py-1 font-medium text-primary">
            380 KB
          </span>
        </div>
      )
    case 'convert':
      return (
        <div className="flex items-center gap-2 text-[11px] font-medium">
          <span className="rounded-md bg-background/70 px-2 py-1 text-muted-foreground">PNG</span>
          <ArrowRight className="h-3 w-3 text-muted-foreground" />
          <span className="rounded-md bg-primary/15 px-2 py-1 text-primary">WEBP</span>
        </div>
      )
    case 'resize':
      return (
        <div className="relative h-12 w-16 rounded-md border border-dashed border-muted-foreground/40">
          <div className="absolute bottom-0 left-0 h-8 w-11 rounded-md bg-primary/25 ring-1 ring-primary/70" />
        </div>
      )
    case 'crop':
      return (
        <div className="relative flex h-12 w-20 items-center justify-center rounded-md bg-background/60">
          <div className="h-12 w-12 rounded-sm ring-2 ring-primary" />
        </div>
      )
    case 'rotate':
      return (
        <div className="flex items-center gap-3">
          <div className="h-8 w-12 rounded-md bg-background/70" />
          <RotateCw className="h-3.5 w-3.5 text-muted-foreground" />
          <div className="h-12 w-8 rounded-md bg-primary/25 ring-1 ring-primary/70" />
        </div>
      )
    case 'collage':
      return (
        <div className="grid grid-cols-2 gap-1">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={`h-5 w-6 ${i === 1 ? 'rounded-[3px] bg-primary/70' : cell}`} />
          ))}
        </div>
      )
    case 'stitch':
      return (
        <div className="flex flex-col gap-0.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={`h-3.5 w-12 ${i === 0 ? 'rounded-[3px] bg-primary/70' : cell}`}
            />
          ))}
        </div>
      )
    case 'slice':
      return (
        <div className="grid grid-cols-3 gap-0.5">
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} className={`h-4 w-4 ${i === 4 ? 'rounded-[3px] bg-primary/70' : cell}`} />
          ))}
        </div>
      )
  }
}

function IntakeBar() {
  const items = useProto((s) => s.items)
  const clear = useProto((s) => s.clear)
  const { dragging, openFiles, openFolder } = useIntakeContext()
  const bytes = items.reduce((sum, item) => sum + item.size, 0)
  return (
    <div
      className={`flex flex-wrap items-center gap-5 rounded-2xl p-5 ring-1 transition-colors ${
        dragging ? 'bg-primary/10 ring-primary/60' : 'bg-card ring-border/60'
      }`}
    >
      {items.length === 0 ? (
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <ImagePlus className="h-5 w-5" />
        </span>
      ) : (
        <span className="flex shrink-0 -space-x-3">
          {items.slice(0, 5).map((item) => (
            <img
              key={item.id}
              src={item.url}
              alt=""
              className="h-12 w-12 rounded-lg object-cover ring-2 ring-card"
            />
          ))}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-medium">
          {items.length === 0
            ? '添加图片后选择工具'
            : `已导入 ${items.length} 张 · ${formatBytes(bytes)}`}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {items.length === 0
            ? '支持拖放、粘贴，或选择文件与文件夹；图片在本地处理'
            : '选择下方工具开始处理，切换工具不会清空图片'}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button variant={items.length === 0 ? 'default' : 'secondary'} onClick={openFiles}>
          <ImagePlus />
          {items.length === 0 ? '选择图片' : '继续添加'}
        </Button>
        <Button variant="secondary" onClick={openFolder}>
          <FolderOpen />
          文件夹
        </Button>
        {items.length > 0 && (
          <Button variant="ghost" className="text-muted-foreground" onClick={clear}>
            清空
          </Button>
        )}
      </div>
    </div>
  )
}

function ToolCard({ tool, onPick }: { tool: ToolId; onPick: (tool: ToolId) => void }) {
  const Icon = TOOLS[tool].icon
  return (
    <button
      type="button"
      onClick={() => onPick(tool)}
      className="group flex flex-col rounded-2xl bg-card p-2 text-left ring-1 ring-border/60 transition hover:-translate-y-0.5 hover:ring-primary/50"
    >
      <div className="grid h-24 place-items-center rounded-xl bg-secondary/50 transition-colors group-hover:bg-secondary/80">
        <ToolArt tool={tool} />
      </div>
      <div className="flex items-start gap-2.5 px-2 pb-2 pt-3">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{TOOLS[tool].name}</div>
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{TOOLS[tool].desc}</div>
        </div>
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
    </button>
  )
}

function Catalog({ onPick }: { onPick: (tool: ToolId) => void }) {
  const intake = useIntake()
  return (
    <IntakeContext.Provider value={intake}>
      <main {...intake.dropZoneProps} className="flex h-[calc(100dvh-3.5rem)] flex-col">
        {intake.inputs}
        <div className="studio-page-head flex shrink-0 items-center gap-3 py-3 pl-5 pr-16 md:pr-60">
          <h1 className="font-display text-[15px] font-medium">{APP_MODE_LABELS.tools}</h1>
          <span className="text-xs text-muted-foreground">图片在本地处理，不会上传</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-2 md:px-8">
          <div className="mx-auto max-w-5xl space-y-8">
            <IntakeBar />
            {[
              { title: '图片处理', hint: '逐张处理，支持批量', tools: PROCESS_TOOLS },
              { title: '图片合成', hint: '多张合成一张，或单张切分', tools: COMPOSE_TOOLS },
            ].map((group) => (
              <section key={group.title}>
                <div className="mb-3 flex items-baseline gap-3">
                  <h2 className="text-sm font-medium">{group.title}</h2>
                  <span className="text-xs text-muted-foreground">{group.hint}</span>
                </div>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
                  {group.tools.map((tool) => (
                    <ToolCard key={tool} tool={tool} onPick={onPick} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </main>
    </IntakeContext.Provider>
  )
}

// ================================================================ 工具页骨架

function ToolRail({ tool, onPick }: { tool: ToolId; onPick: (tool: ToolId) => void }) {
  const row = (id: ToolId) => {
    const Icon = TOOLS[id].icon
    const on = id === tool
    return (
      <button
        key={id}
        type="button"
        onClick={() => onPick(id)}
        className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors ${
          on
            ? 'bg-secondary font-medium text-foreground'
            : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
        }`}
      >
        <Icon className={`h-4 w-4 ${on ? 'text-primary' : ''}`} />
        {TOOLS[id].name}
      </button>
    )
  }
  return (
    <nav className="hidden w-48 shrink-0 flex-col gap-5 overflow-y-auto border-r border-border/60 p-3 md:flex">
      <div className="space-y-0.5">
        <div className="px-2.5 pb-1.5 text-[11px] text-muted-foreground">处理</div>
        {PROCESS_TOOLS.map(row)}
      </div>
      <div className="space-y-0.5">
        <div className="px-2.5 pb-1.5 text-[11px] text-muted-foreground">合成</div>
        {COMPOSE_TOOLS.map(row)}
      </div>
    </nav>
  )
}

function ToolView({
  tool,
  onPick,
  onBack,
}: {
  tool: ToolId
  onPick: (tool: ToolId) => void
  onBack: () => void
}) {
  const items = useProto((s) => s.items)
  const clear = useProto((s) => s.clear)
  const intake = useIntake()
  const Icon = TOOLS[tool].icon
  return (
    <IntakeContext.Provider value={intake}>
      <main {...intake.dropZoneProps} className="flex h-[calc(100dvh-3.5rem)] flex-col">
        {intake.inputs}
        <div className="studio-page-head flex shrink-0 items-center gap-1.5 border-b border-border/60 py-2.5 pl-3 pr-16 md:pr-60">
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onBack}>
            <ArrowLeft />
            {APP_MODE_LABELS.tools}
          </Button>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="flex items-center gap-2 pl-1 text-[15px] font-medium">
            <Icon className="h-4 w-4 text-primary" />
            {TOOLS[tool].name}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={intake.openFiles}>
              <ImagePlus />
              添加图片
            </Button>
            <Button variant="ghost" size="sm" onClick={intake.openFolder}>
              <FolderOpen />
              文件夹
            </Button>
            {items.length > 0 && (
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={clear}>
                清空 {items.length} 张
              </Button>
            )}
          </span>
        </div>
        <div className="flex min-h-0 flex-1">
          <ToolRail tool={tool} onPick={onPick} />
          {isCompose(tool) ? (
            <ComposeWorkspace key={tool} tool={tool} />
          ) : (
            <ProcessWorkspace key={tool} tool={tool} />
          )}
        </div>
      </main>
    </IntakeContext.Provider>
  )
}

function EmptyStage({ tool }: { tool: ToolId }) {
  const { dragging, openFiles, openFolder } = useIntakeContext()
  return (
    <div className="flex min-h-0 flex-1 p-5">
      <div
        className={`flex flex-1 flex-col items-center justify-center gap-5 rounded-2xl ring-1 transition-colors ${
          dragging ? 'bg-primary/10 ring-primary/60' : 'bg-card/60 ring-border/60'
        }`}
      >
        <div className="grid h-28 w-44 place-items-center rounded-2xl bg-secondary/50">
          <ToolArt tool={tool} />
        </div>
        <div className="text-center">
          <div className="text-[15px] font-medium">添加图片以开始{TOOLS[tool].name}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {tool === 'slice' ? '仅处理第一张图片' : '支持多张图片与整个文件夹，也可直接粘贴'}
          </div>
        </div>
        <div className="flex gap-2">
          <Button onClick={openFiles}>
            <ImagePlus />
            选择图片
          </Button>
          <Button variant="secondary" onClick={openFolder}>
            <FolderOpen />
            选择文件夹
          </Button>
        </div>
      </div>
    </div>
  )
}

function Panel({
  tool,
  children,
  footer,
}: {
  tool: ToolId
  children: ReactNode
  footer: ReactNode
}) {
  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-border/60">
      <div className="px-5 pb-1 pt-5">
        <h2 className="text-sm font-semibold">{TOOLS[tool].name}设置</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{TOOLS[tool].desc}</p>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4">{children}</div>
      <div className="space-y-2 border-t border-border/60 p-4">{footer}</div>
    </aside>
  )
}

// ================================================================ 设置零件

function Section({
  title,
  aside,
  children,
}: {
  title: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Tile({
  active,
  disabled,
  onClick,
  className = '',
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  className?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-xl px-3 py-2.5 text-left ring-1 transition-colors disabled:pointer-events-none disabled:opacity-40 ${
        active
          ? 'bg-primary/10 ring-primary/70'
          : 'bg-secondary/50 ring-transparent hover:bg-secondary'
      } ${className}`}
    >
      {children}
    </button>
  )
}

function TileText({ title, hint, active }: { title: string; hint?: string; active: boolean }) {
  return (
    <>
      <span className={`block text-[13px] font-medium ${active ? 'text-primary' : ''}`}>
        {title}
      </span>
      {hint && (
        <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{hint}</span>
      )}
    </>
  )
}

function Chips<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: readonly { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          onClick={() => onChange(option.value)}
          className={`h-7 rounded-full px-3 text-xs tabular-nums transition-colors ${
            value === option.value
              ? 'bg-primary font-medium text-primary-foreground'
              : 'bg-secondary/60 text-muted-foreground hover:text-foreground'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function QualityControl() {
  const quality = useProto((s) => s.recipe.quality)
  const setRecipe = useProto((s) => s.setRecipe)
  return (
    <Section
      title="画质"
      aside={<span className="text-sm font-semibold tabular-nums">{quality}</span>}
    >
      <input
        type="range"
        min={5}
        max={100}
        value={quality}
        aria-label="画质"
        onChange={(event) => setRecipe({ quality: Number(event.target.value) })}
        className="h-1.5 w-full accent-[hsl(var(--primary))]"
      />
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>体积优先</span>
        <span>画质优先</span>
      </div>
      <Chips
        value={quality}
        options={[60, 75, 85, 95].map((value) => ({ value, label: String(value) }))}
        onChange={(value) => setRecipe({ quality: value })}
      />
    </Section>
  )
}

const FORMAT_TILES: readonly { value: OutputFormat; title: string; hint: string }[] = [
  { value: 'image/jpeg', title: 'JPG', hint: '兼容性最好，适合照片' },
  { value: 'image/png', title: 'PNG', hint: '无损，支持透明背景' },
  { value: 'image/webp', title: 'WebP', hint: '体积更小，网页常用' },
  { value: 'image/avif', title: 'AVIF', hint: '体积最小，兼容性较新' },
]

const CROP_RATIOS = [
  { value: '1:1', w: 1, h: 1 },
  { value: '4:3', w: 4, h: 3 },
  { value: '3:4', w: 3, h: 4 },
  { value: '16:9', w: 16, h: 9 },
  { value: '9:16', w: 9, h: 16 },
] as const

const CROP_PLATFORMS = [
  { value: 'taobao', name: '淘宝主图', size: '800×800' },
  { value: 'amazon', name: 'Amazon', size: '2000×2000' },
  { value: 'xhs', name: '小红书', size: '1242×1660' },
  { value: 'douyin', name: '抖音', size: '1080×1920' },
  { value: 'wechat', name: '公众号封面', size: '900×383' },
] as const

function ProcessSettings({ tool }: { tool: ProcessTool }) {
  const recipe = useProto((s) => s.recipe)
  const setRecipe = useProto((s) => s.setRecipe)
  const lossy = recipe.format !== 'image/png'

  switch (tool) {
    case 'compress':
      return (
        <>
          <Section title="输出格式">
            <div className="grid grid-cols-4 gap-1.5">
              {(
                [
                  { value: 'keep', title: '原格式' },
                  { value: 'image/jpeg', title: 'JPG' },
                  { value: 'image/webp', title: 'WebP' },
                  { value: 'image/avif', title: 'AVIF' },
                ] as const
              ).map((option) => (
                <Tile
                  key={option.value}
                  active={recipe.format === option.value}
                  onClick={() => setRecipe({ format: option.value })}
                  className="px-0 text-center"
                >
                  <TileText title={option.title} active={recipe.format === option.value} />
                </Tile>
              ))}
            </div>
          </Section>
          <Section title="压缩方式">
            <div className="grid grid-cols-2 gap-1.5">
              <Tile
                active={recipe.compressMode === 'quality'}
                onClick={() => setRecipe({ compressMode: 'quality' })}
              >
                <TileText
                  title="按画质"
                  hint="设定画质，体积随图而变"
                  active={recipe.compressMode === 'quality'}
                />
              </Tile>
              <Tile
                active={recipe.compressMode === 'target'}
                disabled={!lossy}
                onClick={() => setRecipe({ compressMode: 'target' })}
              >
                <TileText
                  title="指定体积"
                  hint="自动调整画质以达标"
                  active={recipe.compressMode === 'target'}
                />
              </Tile>
            </div>
          </Section>
          {recipe.compressMode === 'quality' || !lossy ? (
            <QualityControl />
          ) : (
            <Section title="目标体积（每张）">
              <Chips
                value={recipe.targetKb}
                options={[100, 200, 500, 1000].map((value) => ({
                  value,
                  label: value >= 1000 ? `${value / 1000} MB` : `${value} KB`,
                }))}
                onChange={(targetKb) => setRecipe({ targetKb })}
              />
              <NumberField
                value={recipe.targetKb}
                suffix="KB"
                className="w-full"
                onChange={(targetKb) => setRecipe({ targetKb })}
              />
            </Section>
          )}
        </>
      )
    case 'convert':
      return (
        <>
          <Section title="转成">
            <div className="grid grid-cols-2 gap-1.5">
              {FORMAT_TILES.map((option) => (
                <Tile
                  key={option.value}
                  active={recipe.format === option.value}
                  onClick={() => setRecipe({ format: option.value })}
                >
                  <TileText
                    title={option.title}
                    hint={option.hint}
                    active={recipe.format === option.value}
                  />
                </Tile>
              ))}
            </div>
          </Section>
          {lossy && recipe.format !== 'keep' && <QualityControl />}
          {!lossy && <p className="text-xs text-muted-foreground">PNG 为无损格式，无画质参数。</p>}
        </>
      )
    case 'resize': {
      const unit = recipe.resizeMode === 'percent' ? '%' : 'px'
      const quick = recipe.resizeMode === 'percent' ? [25, 50, 75] : [1080, 1600, 1920, 2560]
      return (
        <>
          <Section title="缩放依据">
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { value: 'longEdge', title: '长边', hint: '统一横竖图长边' },
                  { value: 'width', title: '宽度', hint: '统一输出宽度' },
                  { value: 'percent', title: '百分比', hint: '按原图比例缩放' },
                ] as const
              ).map((option) => (
                <Tile
                  key={option.value}
                  active={recipe.resizeMode === option.value}
                  onClick={() =>
                    setRecipe({
                      resizeMode: option.value,
                      resizeValue: option.value === 'percent' ? 50 : 1600,
                    })
                  }
                >
                  <TileText
                    title={option.title}
                    hint={option.hint}
                    active={recipe.resizeMode === option.value}
                  />
                </Tile>
              ))}
            </div>
          </Section>
          {recipe.resizeMode !== 'none' && (
            <Section title={recipe.resizeMode === 'percent' ? '缩放比例' : '目标尺寸'}>
              <Chips
                value={recipe.resizeValue}
                options={quick.map((value) => ({ value, label: `${value}${unit}` }))}
                onChange={(resizeValue) => setRecipe({ resizeValue })}
              />
              <NumberField
                value={recipe.resizeValue}
                suffix={unit}
                className="w-full"
                onChange={(resizeValue) => setRecipe({ resizeValue })}
              />
              <p className="text-[11px] text-muted-foreground">仅缩小不放大，宽高比保持不变。</p>
            </Section>
          )}
        </>
      )
    }
    case 'crop':
      return (
        <>
          <Section title="比例">
            <div className="grid grid-cols-5 gap-1.5">
              {CROP_RATIOS.map((ratio) => {
                const on = recipe.crop === ratio.value
                const scale = 22 / Math.max(ratio.w, ratio.h)
                return (
                  <Tile
                    key={ratio.value}
                    active={on}
                    onClick={() => setRecipe({ crop: ratio.value, cropX: 0.5, cropY: 0.5 })}
                    className="flex flex-col items-center gap-2 px-0 py-3"
                  >
                    <span className="grid h-6 place-items-center">
                      <span
                        className={`block rounded-[3px] ${on ? 'bg-primary/40 ring-1 ring-primary' : 'bg-muted-foreground/30'}`}
                        style={{ width: ratio.w * scale, height: ratio.h * scale }}
                      />
                    </span>
                    <span
                      className={`text-[11px] tabular-nums ${on ? 'font-medium text-primary' : ''}`}
                    >
                      {ratio.value}
                    </span>
                  </Tile>
                )
              })}
            </div>
          </Section>
          <Section title="平台尺寸">
            <div className="space-y-1.5">
              {CROP_PLATFORMS.map((platform) => {
                const on = recipe.crop === platform.value
                return (
                  <Tile
                    key={platform.value}
                    active={on}
                    onClick={() => setRecipe({ crop: platform.value, cropX: 0.5, cropY: 0.5 })}
                    className="flex w-full items-center justify-between py-2"
                  >
                    <span className={`text-[13px] ${on ? 'font-medium text-primary' : ''}`}>
                      {platform.name}
                    </span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {platform.size}
                    </span>
                  </Tile>
                )
              })}
            </div>
          </Section>
          <p className="text-[11px] text-muted-foreground">裁切以图片中心为基准。</p>
        </>
      )
    case 'rotate':
      return (
        <>
          <Section title="旋转">
            <div className="grid grid-cols-4 gap-1.5">
              {([0, 90, 180, 270] as const).map((deg) => {
                const on = recipe.rotate === deg
                return (
                  <Tile
                    key={deg}
                    active={on}
                    onClick={() => setRecipe({ rotate: deg })}
                    className="flex flex-col items-center gap-2 px-0 py-3"
                  >
                    <span className="grid h-7 w-7 place-items-center">
                      <span
                        className={`relative block h-4 w-6 rounded-[3px] ${on ? 'bg-primary/40 ring-1 ring-primary' : 'bg-muted-foreground/30'}`}
                        style={{ transform: `rotate(${deg}deg)` }}
                      >
                        <span className="absolute left-1 top-1 h-1 w-1 rounded-full bg-foreground/80" />
                      </span>
                    </span>
                    <span
                      className={`text-[11px] tabular-nums ${on ? 'font-medium text-primary' : ''}`}
                    >
                      {deg}°
                    </span>
                  </Tile>
                )
              })}
            </div>
          </Section>
          <Section title="翻转">
            <div className="grid grid-cols-2 gap-1.5">
              {(
                [
                  { key: 'flipH', title: '水平翻转', icon: FlipHorizontal2 },
                  { key: 'flipV', title: '垂直翻转', icon: FlipVertical2 },
                ] as const
              ).map((flip) => {
                const on = recipe[flip.key]
                const FlipIcon = flip.icon
                return (
                  <Tile
                    key={flip.key}
                    active={on}
                    onClick={() => setRecipe({ [flip.key]: !on })}
                    className="flex items-center gap-2"
                  >
                    <FlipIcon
                      className={`h-4 w-4 ${on ? 'text-primary' : 'text-muted-foreground'}`}
                    />
                    <span className={`text-[13px] ${on ? 'font-medium text-primary' : ''}`}>
                      {flip.title}
                    </span>
                  </Tile>
                )
              })}
            </div>
          </Section>
        </>
      )
  }
}

function ActionButtons({
  entries,
  zipName,
}: {
  entries: { name: string; blob: Blob }[]
  zipName: string
}) {
  return (
    <>
      <Button
        className="w-full"
        disabled={entries.length === 0}
        onClick={() => void downloadAll(entries, zipName)}
      >
        <Download />
        {entries.length > 1 ? `下载全部（${entries.length}）` : '下载'}
      </Button>
      <Button
        variant="ghost"
        className="w-full text-muted-foreground"
        disabled={entries.length === 0}
        onClick={() => void sendToCreate(entries)}
      >
        <SquareArrowOutUpRight />
        放入创作输入框
      </Button>
    </>
  )
}

// ================================================================ 处理类工具

function ProcessWorkspace({ tool }: { tool: ProcessTool }) {
  const items = useProto((s) => s.items)
  const recipe = useProto((s) => s.recipe)
  const effective = useMemo<Recipe>(
    () => ({
      ...DEFAULT_RECIPE,
      ...Object.fromEntries(TOOL_FIELDS[tool].map((key) => [key, recipe[key]])),
    }),
    [tool, recipe],
  )
  const { results, busy } = useProcessed(items, effective)
  const { before, after } = totalBytes(items, results)
  const [compareId, setCompareId] = useState<string | null>(null)
  const compareItem = items.find((item) => item.id === compareId)
  const entries = doneEntries(items, results).map(({ item, result }) => ({
    name: outputName(item.name, result.blob.type),
    blob: result.blob,
  }))
  const ratio = before > 0 ? Math.min(after / before, 1) : 0

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col">
        {items.length === 0 ? (
          <EmptyStage tool={tool} />
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-2 px-5 pb-1 pt-4 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{items.length} 张</span>
              <span>· 点击图片查看前后对比</span>
              {busy && (
                <span className="ml-auto flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  处理中
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-5 pt-3">
              <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-4">
                {items.map((item) => (
                  <ResultCard
                    key={item.id}
                    item={item}
                    state={results.get(item.id)}
                    onOpen={() => setCompareId(item.id)}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
      <Panel
        tool={tool}
        footer={
          <>
            {before > 0 && (
              <div className="mb-2 space-y-2 rounded-xl bg-secondary/50 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-muted-foreground">总体积</span>
                  <span
                    className={`text-lg font-semibold tabular-nums ${after <= before ? 'text-success' : 'text-warning'}`}
                  >
                    {busy ? '…' : savingLabel(before, after)}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-background">
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${ratio * 100}%` }}
                  />
                </div>
                <div className="flex justify-between text-[11px] tabular-nums text-muted-foreground">
                  <span>{formatBytes(before)}</span>
                  <span className="text-foreground">{formatBytes(after)}</span>
                </div>
              </div>
            )}
            <ActionButtons entries={entries} zipName={`${TOOLS[tool].name}.zip`} />
          </>
        }
      >
        <ProcessSettings tool={tool} />
      </Panel>
      {compareItem && (
        <CompareView
          item={compareItem}
          state={results.get(compareItem.id)}
          onClose={() => setCompareId(null)}
        />
      )}
    </>
  )
}

function ResultCard({
  item,
  state,
  onOpen,
}: {
  item: ProtoItem
  state: ResultState | undefined
  onOpen: () => void
}) {
  const remove = useProto((s) => s.remove)
  const done = state?.status === 'done' ? state.result : null
  return (
    <div className="group overflow-hidden rounded-xl bg-card ring-1 ring-border/60 transition hover:ring-primary/50">
      <div className="relative">
        <button type="button" onClick={onOpen} className={`block aspect-[4/3] w-full ${CHECKER}`}>
          <img
            src={done?.url ?? item.url}
            alt=""
            className={`h-full w-full object-contain p-2 transition-opacity ${done ? '' : 'opacity-50'}`}
          />
        </button>
        {done && (
          <span
            className={`pointer-events-none absolute left-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
              done.blob.size <= item.size
                ? 'bg-success/15 text-success'
                : 'bg-warning/15 text-warning'
            }`}
          >
            {savingLabel(item.size, done.blob.size)}
          </span>
        )}
        {!done && state?.status !== 'error' && (
          <Loader2 className="pointer-events-none absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 animate-spin text-primary" />
        )}
        <span className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          {done && (
            <button
              type="button"
              aria-label="下载"
              onClick={() => downloadBlob(done.blob, outputName(item.name, done.blob.type))}
              className="grid h-7 w-7 place-items-center rounded-lg bg-background/85 backdrop-blur hover:bg-background"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            aria-label="移除"
            onClick={() => remove(item.id)}
            className="grid h-7 w-7 place-items-center rounded-lg bg-background/85 backdrop-blur hover:bg-background"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
      <div className="space-y-1 px-3 py-2.5">
        <div className="truncate text-[13px] font-medium" title={item.name}>
          {item.name}
        </div>
        {state?.status === 'error' ? (
          <div className="text-[11px] text-destructive">{state.message}</div>
        ) : (
          <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums text-muted-foreground">
            <span className="truncate">
              {formatBytes(item.size)}
              {done && (
                <>
                  {' → '}
                  <span className="text-foreground">{formatBytes(done.blob.size)}</span>
                </>
              )}
            </span>
            <span className="shrink-0">
              {done ? `${done.width}×${done.height}` : `${item.width}×${item.height}`}
            </span>
          </div>
        )}
        {done && (done.fellBack || done.overTarget) && (
          <div className="flex flex-wrap gap-1">
            <ResultBadges fellBack={done.fellBack} overTarget={done.overTarget} />
          </div>
        )}
      </div>
    </div>
  )
}

function CompareView({
  item,
  state,
  onClose,
}: {
  item: ProtoItem
  state: ResultState | undefined
  onClose: () => void
}) {
  const [split, setSplit] = useState(50)
  const done = state?.status === 'done' ? state.result : null
  // 裁剪或旋转改了比例时，叠在一起的分割线对不齐，改成左右并排。
  const sameAspect = !!done && Math.abs(item.width / item.height - done.width / done.height) < 0.01

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur">
      <div className="flex shrink-0 items-center gap-3 px-5 py-3 text-[13px]">
        <span className="truncate font-medium">{item.name}</span>
        {done && (
          <span className="flex items-center gap-2 tabular-nums text-muted-foreground">
            {item.width}×{item.height} · {formatBytes(item.size)}
            <ArrowRight className="h-3 w-3" />
            <span className="text-foreground">
              {done.width}×{done.height} · {formatBytes(done.blob.size)}
            </span>
            <span className={done.blob.size <= item.size ? 'text-success' : 'text-warning'}>
              {savingLabel(item.size, done.blob.size)}
            </span>
          </span>
        )}
        <span className="ml-auto flex gap-1.5">
          {done && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => downloadBlob(done.blob, outputName(item.name, done.blob.type))}
            >
              <Download />
              下载这张
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-label="关闭" onClick={onClose}>
            <X />
          </Button>
        </span>
      </div>
      {done && !sameAspect ? (
        <div className="mx-5 mb-5 grid min-h-0 flex-1 grid-cols-2 gap-3">
          {[
            { label: '原图', url: item.url, on: false },
            { label: '处理后', url: done.url, on: true },
          ].map((pane) => (
            <div
              key={pane.label}
              className={`relative min-h-0 overflow-hidden rounded-xl ${CHECKER}`}
            >
              <img src={pane.url} alt="" className="h-full w-full object-contain p-4" />
              <span
                className={`absolute left-3 top-3 rounded-md px-2 py-0.5 text-[11px] ${
                  pane.on ? 'bg-primary font-medium text-primary-foreground' : 'bg-background/80'
                }`}
              >
                {pane.label}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className={`relative mx-5 mb-5 min-h-0 flex-1 overflow-hidden rounded-xl ${CHECKER}`}>
          {done ? (
            <>
              <img
                src={done.url}
                alt=""
                className="absolute inset-0 h-full w-full object-contain"
              />
              <img
                src={item.url}
                alt=""
                className="absolute inset-0 h-full w-full object-contain"
                style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
              />
              <div
                className="pointer-events-none absolute inset-y-0 w-px bg-primary"
                style={{ left: `${split}%` }}
              >
                <span className="absolute left-1/2 top-1/2 grid h-8 w-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-primary text-primary-foreground shadow">
                  <ArrowRightLeft className="h-3.5 w-3.5" />
                </span>
              </div>
              <span className="pointer-events-none absolute left-3 top-3 rounded-md bg-background/80 px-2 py-0.5 text-[11px]">
                原图
              </span>
              <span className="pointer-events-none absolute right-3 top-3 rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground">
                处理后
              </span>
              <input
                type="range"
                min={0}
                max={100}
                value={split}
                aria-label="对比分割线"
                onChange={(event) => setSplit(Number(event.target.value))}
                className="absolute inset-0 h-full w-full cursor-ew-resize opacity-0"
              />
            </>
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              处理中…
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ================================================================ 合成类工具

const BACKGROUNDS = [
  { value: '#ffffff', label: '白' },
  { value: '#000000', label: '黑' },
  { value: '#f3f4f6', label: '浅灰' },
] as const

function ComposeSettings({ tool }: { tool: ComposeTool }) {
  const options = useProto((s) => s.composeOptions)
  const setCompose = useProto((s) => s.setCompose)

  if (tool === 'slice')
    return (
      <>
        <Section title="切分方式">
          <div className="grid grid-cols-4 gap-1.5">
            {(
              [
                [3, 3],
                [2, 2],
                [1, 3],
                [3, 1],
              ] as const
            ).map(([rows, columns]) => {
              const on = options.rows === rows && options.columns === columns
              return (
                <Tile
                  key={`${rows}x${columns}`}
                  active={on}
                  onClick={() => setCompose({ rows, columns })}
                  className="flex flex-col items-center gap-2 px-0 py-3"
                >
                  <span
                    className="grid gap-px"
                    style={{ gridTemplateColumns: `repeat(${columns}, 6px)` }}
                  >
                    {Array.from({ length: rows * columns }, (_, i) => (
                      <span
                        key={i}
                        className={`h-1.5 w-1.5 rounded-[1px] ${on ? 'bg-primary' : 'bg-muted-foreground/50'}`}
                      />
                    ))}
                  </span>
                  <span className={`text-[11px] ${on ? 'font-medium text-primary' : ''}`}>
                    {rows}×{columns}
                  </span>
                </Tile>
              )
            })}
          </div>
        </Section>
        <Section title="切分前裁为正方形">
          <div className="grid grid-cols-2 gap-1.5">
            {[true, false].map((value) => (
              <Tile
                key={String(value)}
                active={options.squareFirst === value}
                onClick={() => setCompose({ squareFirst: value })}
              >
                <TileText
                  title={value ? '是' : '否'}
                  hint={value ? '输出等宽等高' : '保留原始比例'}
                  active={options.squareFirst === value}
                />
              </Tile>
            ))}
          </div>
        </Section>
      </>
    )

  return (
    <>
      {tool === 'stitch' ? (
        <Section title="方向">
          <div className="grid grid-cols-2 gap-1.5">
            {(
              [
                { value: 'vertical', title: '纵向拼接', hint: '长截图、图文' },
                { value: 'horizontal', title: '横向拼接', hint: '对比图、全景图' },
              ] as const
            ).map((option) => (
              <Tile
                key={option.value}
                active={options.direction === option.value}
                onClick={() => setCompose({ direction: option.value })}
              >
                <TileText
                  title={option.title}
                  hint={option.hint}
                  active={options.direction === option.value}
                />
              </Tile>
            ))}
          </div>
        </Section>
      ) : (
        <Section title="每行数量">
          <div className="grid grid-cols-3 gap-1.5">
            {[2, 3, 4].map((columns) => (
              <Tile
                key={columns}
                active={options.columns === columns}
                onClick={() => setCompose({ columns })}
                className="text-center"
              >
                <TileText title={`${columns} 张`} active={options.columns === columns} />
              </Tile>
            ))}
          </div>
        </Section>
      )}
      <Section title="间距" aside={<span className="text-xs tabular-nums">{options.gap}px</span>}>
        <Chips
          value={options.gap}
          options={[0, 8, 16, 32].map((value) => ({ value, label: `${value}px` }))}
          onChange={(gap) => setCompose({ gap })}
        />
      </Section>
      <Section title="底色">
        <div className="flex gap-2">
          {BACKGROUNDS.map((bg) => {
            const on = options.background === bg.value
            return (
              <button
                key={bg.value}
                type="button"
                onClick={() => setCompose({ background: bg.value })}
                className={`flex h-9 items-center gap-2 rounded-lg px-2.5 text-xs ring-1 transition-colors ${
                  on
                    ? 'bg-primary/10 ring-primary/70'
                    : 'bg-secondary/50 ring-transparent hover:bg-secondary'
                }`}
              >
                <span
                  className="h-4 w-4 rounded-full ring-1 ring-border"
                  style={{ background: bg.value }}
                />
                {bg.label}
              </button>
            )
          })}
        </div>
      </Section>
    </>
  )
}

function OrderList({ tool }: { tool: ComposeTool }) {
  const items = useProto((s) => s.items)
  const move = useProto((s) => s.move)
  const remove = useProto((s) => s.remove)
  if (items.length === 0) return null
  return (
    <Section title={tool === 'slice' ? '图片（仅用第一张）' : `拼接顺序 · ${items.length} 张`}>
      <div className="space-y-1">
        {items.map((item, index) => (
          <div
            key={item.id}
            className={`group flex items-center gap-2.5 rounded-lg p-1 pr-1.5 hover:bg-secondary/50 ${
              tool === 'slice' && index > 0 ? 'opacity-40' : ''
            }`}
          >
            <span className="w-4 text-center text-[11px] tabular-nums text-muted-foreground">
              {index + 1}
            </span>
            <img src={item.url} alt="" className="h-9 w-9 rounded-md object-cover" />
            <span className="min-w-0 flex-1 truncate text-xs">{item.name}</span>
            <span className="flex opacity-0 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                aria-label="上移"
                onClick={() => move(item.id, -1)}
                className="grid h-6 w-6 place-items-center rounded hover:bg-background"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label="下移"
                onClick={() => move(item.id, 1)}
                className="grid h-6 w-6 place-items-center rounded hover:bg-background"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label="移除"
                onClick={() => remove(item.id)}
                className="grid h-6 w-6 place-items-center rounded hover:bg-background"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </span>
          </div>
        ))}
      </div>
    </Section>
  )
}

function ComposeWorkspace({ tool }: { tool: ComposeTool }) {
  const items = useProto((s) => s.items)
  const options = useProto((s) => s.composeOptions)
  const effective = useMemo<ComposeOptions>(() => ({ ...options, mode: tool }), [options, tool])
  const sources = tool === 'slice' ? items.slice(0, 1) : items
  const state = useComposed(sources, effective, true)
  const outputs = state.status === 'done' ? state.outputs : []
  const entries = outputs.map((out, index) => ({
    name: tool === 'slice' ? `切图-${index + 1}.jpg` : `${TOOLS[tool].name}.jpg`,
    blob: out.blob,
  }))
  const first = outputs[0]

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col">
        {items.length === 0 ? (
          <EmptyStage tool={tool} />
        ) : (
          <div className="min-h-0 flex-1 p-5">
            <div
              className={`relative grid h-full place-items-center overflow-auto rounded-2xl p-8 ring-1 ring-border/60 ${CHECKER}`}
            >
              {state.status === 'error' ? (
                <span className="text-sm text-destructive">{state.message}</span>
              ) : tool === 'slice' && outputs.length > 0 ? (
                <div
                  className="grid w-full max-w-lg gap-1.5"
                  style={{ gridTemplateColumns: `repeat(${options.columns}, minmax(0, 1fr))` }}
                >
                  {outputs.map((out) => (
                    <img
                      key={out.url}
                      src={out.url}
                      alt=""
                      className="w-full rounded-md shadow-lg"
                    />
                  ))}
                </div>
              ) : first ? (
                <img
                  src={first.url}
                  alt=""
                  className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
                />
              ) : (
                <span className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  合成中
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      <Panel
        tool={tool}
        footer={
          <>
            {first && (
              <div className="mb-2 flex items-baseline justify-between rounded-xl bg-secondary/50 px-3 py-2.5 text-xs tabular-nums">
                <span className="text-muted-foreground">
                  {tool === 'slice' ? `${outputs.length} 张切图` : '输出'}
                </span>
                <span>
                  {first.width}×{first.height} ·{' '}
                  {formatBytes(outputs.reduce((sum, out) => sum + out.blob.size, 0))}
                </span>
              </div>
            )}
            <ActionButtons entries={entries} zipName={`${TOOLS[tool].name}.zip`} />
          </>
        }
      >
        <ComposeSettings tool={tool} />
        <OrderList tool={tool} />
      </Panel>
    </>
  )
}
