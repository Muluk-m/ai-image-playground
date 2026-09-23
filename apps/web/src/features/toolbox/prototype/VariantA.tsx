// PROTOTYPE — throwaway。变体 A「工具目录」：先选一件工具，进去只做这一件事（iLoveIMG / 改图宝式）。
// 取舍：入口最好懂、每个工具的参数最少；代价是「缩到 1600 再转 WebP 再压到 200KB」要来回进三次。

import {
  ArrowLeft,
  ArrowRightLeft,
  ChevronDown,
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
  Minimize2,
  RotateCw,
  Scaling,
  SquareArrowOutUpRight,
  X,
} from 'lucide-react'
import { type ComponentType, type ReactNode, useMemo, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { APP_MODE_LABELS } from '../../../store'
import {
  type ComposeOptions,
  DEFAULT_RECIPE,
  downloadAll,
  formatBytes,
  outputName,
  type Recipe,
  savingLabel,
} from './ops'
import {
  CROP_OPTIONS,
  Field,
  FORMAT_OPTIONS,
  NumberField,
  PickSelect,
  QualitySlider,
  RESIZE_OPTIONS,
  ResultBadges,
  ROTATE_OPTIONS,
  Segmented,
  sendToCreate,
  useIntake,
} from './shared'
import { doneEntries, totalBytes, useComposed, useProcessed, useProto } from './state'

type ProcessTool = 'compress' | 'convert' | 'resize' | 'crop' | 'rotate'
type ComposeTool = 'collage' | 'stitch' | 'slice'
type ToolId = ProcessTool | ComposeTool

interface ToolMeta {
  name: string
  icon: ComponentType<{ className?: string }>
  meta: string
}

const TOOLS: Record<ToolId, ToolMeta> = {
  compress: { name: '压缩', icon: Minimize2, meta: '质量 · 目标体积' },
  convert: { name: '转格式', icon: ArrowRightLeft, meta: 'JPG · PNG · WebP · AVIF' },
  resize: { name: '改尺寸', icon: Scaling, meta: '长边 · 宽度 · 百分比' },
  crop: { name: '裁剪', icon: Crop, meta: '比例 · 电商 / 社媒尺寸' },
  rotate: { name: '旋转翻转', icon: RotateCw, meta: '90° · 水平 · 垂直' },
  collage: { name: '拼图', icon: LayoutGrid, meta: '宫格 · 间距 · 底色' },
  stitch: { name: '长图拼接', icon: GalleryVertical, meta: '竖拼 · 横拼' },
  slice: { name: '九宫格切图', icon: Grid3x3, meta: '3×3 · 2×2 · 1×3' },
}

const PROCESS_TOOLS: readonly ProcessTool[] = ['compress', 'convert', 'resize', 'crop', 'rotate']
const COMPOSE_TOOLS: readonly ComposeTool[] = ['collage', 'stitch', 'slice']

/** 每件工具只读配方里属于自己的字段，其余一律按默认值：进「压缩」不会顺带把上次的裁剪也做了。 */
const TOOL_FIELDS: Record<ProcessTool, readonly (keyof Recipe)[]> = {
  compress: ['format', 'compressMode', 'quality', 'targetKb'],
  convert: ['format', 'quality'],
  resize: ['resizeMode', 'resizeValue'],
  crop: ['crop', 'cropX', 'cropY'],
  rotate: ['rotate', 'flipH', 'flipV'],
}

export default function VariantA() {
  const [tool, setTool] = useState<ToolId | null>(null)
  return tool ? <ToolView tool={tool} onBack={() => setTool(null)} /> : <Catalog onPick={setTool} />
}

function Catalog({ onPick }: { onPick: (tool: ToolId) => void }) {
  const count = useProto((s) => s.items.length)
  const clear = useProto((s) => s.clear)
  const { dropZoneProps, dragging, inputs } = useIntake()
  const card = (id: ToolId) => {
    const Icon = TOOLS[id].icon
    return (
      <button
        key={id}
        type="button"
        onClick={() => onPick(id)}
        className="group flex flex-col items-start gap-3 rounded-2xl border border-border bg-card p-5 text-left transition-colors hover:border-primary/50 hover:bg-accent/40"
      >
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </span>
        <span>
          <span className="block text-[15px] font-medium">{TOOLS[id].name}</span>
          <span className="mt-1 block text-xs text-muted-foreground">{TOOLS[id].meta}</span>
        </span>
      </button>
    )
  }
  return (
    <main
      {...dropZoneProps}
      className={`flex h-[calc(100dvh-3.5rem)] flex-col ${dragging ? 'bg-primary/5' : ''}`}
    >
      {inputs}
      <div className="studio-page-head flex shrink-0 items-center gap-3 border-b border-border py-3 pl-5 pr-16 md:pr-60">
        <h1 className="font-display text-[15px] font-medium">{APP_MODE_LABELS.tools}</h1>
        {count > 0 && (
          <span className="ml-auto flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs">
            已导入 {count} 张
            <button
              type="button"
              onClick={clear}
              aria-label="清空"
              className="ml-1 hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5 md:p-8">
        <div className="mx-auto max-w-5xl space-y-8">
          <section>
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">单张 / 批量处理</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {PROCESS_TOOLS.map(card)}
            </div>
          </section>
          <section>
            <h2 className="mb-3 text-sm font-medium text-muted-foreground">多图合成</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {COMPOSE_TOOLS.map(card)}
            </div>
          </section>
        </div>
      </div>
    </main>
  )
}

function ToolView({ tool, onBack }: { tool: ToolId; onBack: () => void }) {
  const items = useProto((s) => s.items)
  const clear = useProto((s) => s.clear)
  const { dropZoneProps, dragging, inputs, openFiles, openFolder } = useIntake()
  const Icon = TOOLS[tool].icon
  const compose = (COMPOSE_TOOLS as readonly ToolId[]).includes(tool)

  return (
    <main {...dropZoneProps} className="flex h-[calc(100dvh-3.5rem)] flex-col">
      {inputs}
      <div className="studio-page-head flex shrink-0 flex-wrap items-center gap-2 border-b border-border py-2.5 pl-3 pr-16 md:pr-60">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft />
          {APP_MODE_LABELS.tools}
        </Button>
        <span className="text-muted-foreground">/</span>
        <span className="flex items-center gap-2 text-[15px] font-medium">
          <Icon className="h-4 w-4 text-primary" />
          {TOOLS[tool].name}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={openFiles}>
            <ImagePlus />
            添加图片
          </Button>
          <Button variant="outline" size="sm" onClick={openFolder}>
            <FolderOpen />
            文件夹
          </Button>
          {items.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clear}>
              清空
            </Button>
          )}
        </span>
      </div>
      <div className="flex shrink-0 flex-wrap items-end gap-5 border-b border-border bg-muted/30 px-5 py-3">
        {compose ? (
          <ComposeControls tool={tool as ComposeTool} />
        ) : (
          <ProcessControls tool={tool as ProcessTool} />
        )}
      </div>
      {items.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center p-6">
          <div
            className={`flex w-full max-w-xl flex-col items-center gap-4 rounded-3xl border-2 border-dashed px-8 py-16 ${
              dragging ? 'border-primary bg-primary/5' : 'border-border'
            }`}
          >
            <Icon className="h-10 w-10 text-muted-foreground" />
            <div className="text-sm text-muted-foreground">拖入图片或文件夹，也可以直接粘贴</div>
            <div className="flex gap-2">
              <Button onClick={openFiles}>选择图片</Button>
              <Button variant="outline" onClick={openFolder}>
                选择文件夹
              </Button>
            </div>
          </div>
        </div>
      ) : compose ? (
        <ComposeBody tool={tool as ComposeTool} />
      ) : (
        <ProcessBody tool={tool as ProcessTool} />
      )}
    </main>
  )
}

function ProcessControls({ tool }: { tool: ProcessTool }) {
  const recipe = useProto((s) => s.recipe)
  const setRecipe = useProto((s) => s.setRecipe)
  const lossy = recipe.format !== 'image/png'
  switch (tool) {
    case 'compress':
      return (
        <>
          <Field label="输出格式">
            <PickSelect
              value={recipe.format}
              options={FORMAT_OPTIONS.filter((option) => option.value !== 'image/png')}
              onChange={(format) => setRecipe({ format })}
              className="h-8 w-36 text-[13px]"
            />
          </Field>
          <Field label="方式">
            <Segmented
              value={recipe.compressMode}
              options={[
                { value: 'quality', label: '按质量' },
                { value: 'target', label: '压到指定体积' },
              ]}
              onChange={(compressMode) => setRecipe({ compressMode })}
            />
          </Field>
          {recipe.compressMode === 'quality' ? (
            <Field label="质量">
              <div className="w-56">
                <QualitySlider
                  value={recipe.quality}
                  onChange={(quality) => setRecipe({ quality })}
                />
              </div>
            </Field>
          ) : (
            <Field label="不超过">
              <NumberField
                value={recipe.targetKb}
                suffix="KB"
                onChange={(targetKb) => setRecipe({ targetKb })}
              />
            </Field>
          )}
        </>
      )
    case 'convert':
      return (
        <>
          <Field label="转成">
            <Segmented
              value={recipe.format}
              options={FORMAT_OPTIONS.filter((option) => option.value !== 'keep')}
              onChange={(format) => setRecipe({ format })}
            />
          </Field>
          {lossy && recipe.format !== 'keep' && (
            <Field label="质量">
              <div className="w-56">
                <QualitySlider
                  value={recipe.quality}
                  onChange={(quality) => setRecipe({ quality })}
                />
              </div>
            </Field>
          )}
        </>
      )
    case 'resize':
      return (
        <>
          <Field label="按">
            <Segmented
              value={recipe.resizeMode}
              options={RESIZE_OPTIONS}
              onChange={(resizeMode) => setRecipe({ resizeMode })}
            />
          </Field>
          {recipe.resizeMode !== 'none' && (
            <Field label={recipe.resizeMode === 'percent' ? '比例' : '像素'}>
              <NumberField
                value={recipe.resizeValue}
                suffix={recipe.resizeMode === 'percent' ? '%' : 'px'}
                onChange={(resizeValue) => setRecipe({ resizeValue })}
              />
            </Field>
          )}
        </>
      )
    case 'crop':
      return (
        <Field label="比例 / 尺寸">
          <Segmented
            size="sm"
            value={recipe.crop}
            options={CROP_OPTIONS}
            onChange={(crop) => setRecipe({ crop, cropX: 0.5, cropY: 0.5 })}
          />
        </Field>
      )
    case 'rotate':
      return (
        <>
          <Field label="旋转">
            <Segmented
              value={recipe.rotate}
              options={ROTATE_OPTIONS}
              onChange={(rotate) => setRecipe({ rotate })}
            />
          </Field>
          <Field label="翻转">
            <Segmented
              value={`${recipe.flipH ? 'h' : ''}${recipe.flipV ? 'v' : ''}` || 'none'}
              options={[
                { value: 'none', label: '不翻' },
                { value: 'h', label: <FlipHorizontal2 className="h-4 w-4" /> },
                { value: 'v', label: <FlipVertical2 className="h-4 w-4" /> },
                { value: 'hv', label: '都翻' },
              ]}
              onChange={(flip) =>
                setRecipe({ flipH: flip.includes('h'), flipV: flip.includes('v') })
              }
            />
          </Field>
        </>
      )
  }
}

function ProcessBody({ tool }: { tool: ProcessTool }) {
  const items = useProto((s) => s.items)
  const remove = useProto((s) => s.remove)
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
  const entries = doneEntries(items, results).map(({ item, result }) => ({
    name: outputName(item.name, result.blob.type),
    blob: result.blob,
  }))

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {items.map((item) => {
            const state = results.get(item.id)
            const done = state?.status === 'done' ? state.result : null
            return (
              <div
                key={item.id}
                className="group overflow-hidden rounded-2xl border border-border bg-card"
              >
                <div className="relative aspect-square bg-[repeating-conic-gradient(hsl(var(--muted))_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
                  <img
                    src={done?.url ?? item.url}
                    alt=""
                    className="h-full w-full object-contain"
                  />
                  <button
                    type="button"
                    onClick={() => remove(item.id)}
                    aria-label="移除"
                    className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-background/80 opacity-0 shadow group-hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="space-y-1 p-3 text-xs">
                  <div className="truncate font-medium" title={item.name}>
                    {item.name}
                  </div>
                  {state?.status === 'error' ? (
                    <div className="text-destructive">{state.message}</div>
                  ) : done ? (
                    <>
                      <div className="text-muted-foreground">
                        {item.width}×{item.height} → {done.width}×{done.height}
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-muted-foreground">
                          {formatBytes(item.size)} →{' '}
                          <b className="text-foreground">{formatBytes(done.blob.size)}</b>
                        </span>
                        <span
                          className={
                            done.blob.size <= item.size ? 'text-emerald-600' : 'text-amber-600'
                          }
                        >
                          {savingLabel(item.size, done.blob.size)}
                        </span>
                        <ResultBadges fellBack={done.fellBack} overTarget={done.overTarget} />
                      </div>
                    </>
                  ) : (
                    <div className="text-muted-foreground">处理中…</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <Footer
        summary={
          before > 0
            ? `${entries.length} 张 · ${formatBytes(before)} → ${formatBytes(after)}（${savingLabel(before, after)}）`
            : ''
        }
        busy={busy}
        entries={entries}
        zipName={`${TOOLS[tool].name}.zip`}
      />
    </>
  )
}

function ComposeControls({ tool }: { tool: ComposeTool }) {
  const options = useProto((s) => s.composeOptions)
  const setCompose = useProto((s) => s.setCompose)
  const background = (
    <Field label="底色">
      <Segmented
        value={options.background}
        options={[
          { value: '#ffffff', label: '白' },
          { value: '#000000', label: '黑' },
          { value: '#f3f4f6', label: '灰' },
        ]}
        onChange={(value) => setCompose({ background: value })}
      />
    </Field>
  )
  if (tool === 'slice')
    return (
      <>
        <Field label="切成">
          <Segmented
            value={`${options.rows}x${options.columns}`}
            options={[
              { value: '3x3', label: '3×3' },
              { value: '2x2', label: '2×2' },
              { value: '1x3', label: '1×3' },
              { value: '3x1', label: '3×1' },
            ]}
            onChange={(value) => {
              const [rows, columns] = value.split('x').map(Number)
              setCompose({ rows, columns })
            }}
          />
        </Field>
        <Field label="先裁成正方形">
          <Segmented
            value={options.squareFirst ? 'yes' : 'no'}
            options={[
              { value: 'yes', label: '是' },
              { value: 'no', label: '否' },
            ]}
            onChange={(value) => setCompose({ squareFirst: value === 'yes' })}
          />
        </Field>
      </>
    )
  return (
    <>
      {tool === 'stitch' ? (
        <Field label="方向">
          <Segmented
            value={options.direction}
            options={[
              { value: 'vertical', label: '竖拼' },
              { value: 'horizontal', label: '横拼' },
            ]}
            onChange={(direction) => setCompose({ direction })}
          />
        </Field>
      ) : (
        <Field label="每行">
          <Segmented
            value={options.columns}
            options={[2, 3, 4].map((value) => ({ value, label: `${value} 张` }))}
            onChange={(columns) => setCompose({ columns })}
          />
        </Field>
      )}
      <Field label="间距">
        <NumberField
          value={options.gap}
          suffix="px"
          onChange={(gap) => setCompose({ gap })}
          className="w-24"
        />
      </Field>
      {background}
    </>
  )
}

function ComposeBody({ tool }: { tool: ComposeTool }) {
  const items = useProto((s) => s.items)
  const move = useProto((s) => s.move)
  const remove = useProto((s) => s.remove)
  const options = useProto((s) => s.composeOptions)
  const effective = useMemo<ComposeOptions>(() => ({ ...options, mode: tool }), [options, tool])
  const sources = tool === 'slice' ? items.slice(0, 1) : items
  const state = useComposed(sources, effective, true)
  const outputs = state.status === 'done' ? state.outputs : []
  const entries = outputs.map((out, index) => ({
    name: tool === 'slice' ? `切图-${index + 1}.jpg` : `${TOOLS[tool].name}.jpg`,
    blob: out.blob,
  }))

  return (
    <>
      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 space-y-1.5 overflow-y-auto border-r border-border p-3">
          {items.map((item, index) => (
            <div
              key={item.id}
              className={`flex items-center gap-2 rounded-xl border border-border p-1.5 ${
                tool === 'slice' && index > 0 ? 'opacity-40' : ''
              }`}
            >
              <img src={item.url} alt="" className="h-10 w-10 rounded-lg object-cover" />
              <span className="min-w-0 flex-1 truncate text-xs">{item.name}</span>
              <span className="flex flex-col">
                <button type="button" onClick={() => move(item.id, -1)} aria-label="上移">
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => move(item.id, 1)} aria-label="下移">
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </span>
              <button type="button" onClick={() => remove(item.id)} aria-label="移除">
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>
          ))}
        </aside>
        <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-6">
          {state.status === 'error' ? (
            <div className="grid h-full place-items-center text-sm text-destructive">
              {state.message}
            </div>
          ) : tool === 'slice' ? (
            <div
              className="mx-auto grid max-w-xl gap-1.5"
              style={{ gridTemplateColumns: `repeat(${options.columns}, minmax(0, 1fr))` }}
            >
              {outputs.map((out) => (
                <img key={out.url} src={out.url} alt="" className="w-full rounded-sm" />
              ))}
            </div>
          ) : outputs[0] ? (
            <figure className="mx-auto flex max-w-3xl flex-col items-center gap-2">
              <img
                src={outputs[0].url}
                alt=""
                className="max-h-[70vh] w-auto rounded-lg shadow-lg"
              />
              <figcaption className="text-xs text-muted-foreground">
                {outputs[0].width}×{outputs[0].height} · {formatBytes(outputs[0].blob.size)}
              </figcaption>
            </figure>
          ) : (
            <div className="grid h-full place-items-center text-sm text-muted-foreground">
              合成中…
            </div>
          )}
        </div>
      </div>
      <Footer
        summary={outputs.length > 1 ? `${outputs.length} 张切图` : ''}
        busy={state.status === 'pending'}
        entries={entries}
        zipName={`${TOOLS[tool].name}.zip`}
      />
    </>
  )
}

function Footer({
  summary,
  busy,
  entries,
  zipName,
}: {
  summary: ReactNode
  busy: boolean
  entries: { name: string; blob: Blob }[]
  zipName: string
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-background px-5 py-3">
      <span className="text-sm">{busy ? '处理中…' : summary}</span>
      <span className="ml-auto flex gap-2">
        <Button
          variant="outline"
          disabled={entries.length === 0}
          onClick={() => void sendToCreate(entries)}
        >
          <SquareArrowOutUpRight />
          放入创作输入框
        </Button>
        <Button disabled={entries.length === 0} onClick={() => void downloadAll(entries, zipName)}>
          <Download />
          {entries.length > 1 ? `下载全部（${entries.length}）` : '下载'}
        </Button>
      </span>
    </div>
  )
}
