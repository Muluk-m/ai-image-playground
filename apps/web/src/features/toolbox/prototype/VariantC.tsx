// PROTOTYPE — throwaway。变体 C「预览检查器」：一张大图居中，压缩与改尺寸拖对比线看前后，裁剪直接在图上
// 拖框；调参只算选中那张，导出时才把同一份配方跑遍全部（Squoosh 式）。
// 取舍：画质看得最清楚、裁剪最直观；代价是批量时每张的结果要逐张点开才看得到。

import {
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
import { type ComponentType, type PointerEvent, useMemo, useRef, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { downloadBlob } from '../../../lib/downloadImages'
import { APP_MODE_LABELS } from '../../../store'
import {
  type ComposeOptions,
  downloadAll,
  formatBytes,
  outputName,
  planGeometry,
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
import { type ProtoItem, processAll, useComposed, useProcessed, useProto } from './state'

type Panel = 'compress' | 'resize' | 'crop' | 'rotate' | ComposeOptions['mode']

const RAIL: readonly { id: Panel; name: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: 'compress', name: '压缩与格式', icon: Minimize2 },
  { id: 'resize', name: '尺寸', icon: Scaling },
  { id: 'crop', name: '裁剪', icon: Crop },
  { id: 'rotate', name: '旋转', icon: RotateCw },
  { id: 'collage', name: '拼图', icon: LayoutGrid },
  { id: 'stitch', name: '长图', icon: GalleryVertical },
  { id: 'slice', name: '九宫格', icon: Grid3x3 },
]

const COMPOSE_PANELS: readonly Panel[] = ['collage', 'stitch', 'slice']
const STAGE_MAX_H = 'max-h-[calc(100dvh-15rem)]'

export default function VariantC() {
  const [panel, setPanel] = useState<Panel>('compress')
  const items = useProto((s) => s.items)
  const selectedId = useProto((s) => s.selectedId)
  const select = useProto((s) => s.select)
  const remove = useProto((s) => s.remove)
  const move = useProto((s) => s.move)
  const clear = useProto((s) => s.clear)
  const { dropZoneProps, dragging, inputs, openFiles, openFolder } = useIntake()
  const composing = COMPOSE_PANELS.includes(panel)
  const selected = items.find((item) => item.id === selectedId) ?? items[0]

  return (
    <main {...dropZoneProps} className="flex h-[calc(100dvh-3.5rem)] flex-col">
      {inputs}
      <div className="studio-page-head flex shrink-0 items-center gap-3 border-b border-border py-3 pl-5 pr-16 md:pr-60">
        <h1 className="font-display text-[15px] font-medium">{APP_MODE_LABELS.tools}</h1>
        {items.length > 0 && (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={clear}>
            清空 {items.length} 张
          </Button>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col bg-muted/30">
          <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-6">
            {items.length === 0 ? (
              <div
                className={`flex flex-col items-center gap-4 rounded-3xl border-2 border-dashed px-16 py-20 ${
                  dragging ? 'border-primary bg-primary/5' : 'border-border'
                }`}
              >
                <div className="text-sm text-muted-foreground">
                  拖入图片或文件夹，也可以直接粘贴
                </div>
                <div className="flex gap-2">
                  <Button onClick={openFiles}>选择图片</Button>
                  <Button variant="outline" onClick={openFolder}>
                    选择文件夹
                  </Button>
                </div>
              </div>
            ) : composing ? (
              <ComposeStage mode={panel as ComposeOptions['mode']} />
            ) : selected ? (
              <ProcessStage item={selected} panel={panel} />
            ) : null}
          </div>
          {items.length > 0 && (
            <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-t border-border bg-background p-2.5">
              {items.map((item, index) => {
                const active = !composing && item.id === selected?.id
                return (
                  <div key={item.id} className="group relative shrink-0">
                    <button
                      type="button"
                      onClick={() => select(item.id)}
                      className={`block overflow-hidden rounded-lg ring-2 ${
                        active ? 'ring-primary' : 'ring-transparent hover:ring-border'
                      }`}
                    >
                      <img src={item.url} alt="" className="h-14 w-14 object-cover" />
                    </button>
                    {composing && (
                      <span className="absolute left-1 top-1 rounded bg-background/90 px-1 text-[10px] font-semibold">
                        {index + 1}
                      </span>
                    )}
                    <span className="absolute -right-1 -top-1 hidden gap-0.5 group-hover:flex">
                      {composing && (
                        <button
                          type="button"
                          aria-label="前移"
                          onClick={() => move(item.id, -1)}
                          className="grid h-5 w-5 place-items-center rounded-full bg-background text-[10px] shadow"
                        >
                          ←
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label="移除"
                        onClick={() => remove(item.id)}
                        className="grid h-5 w-5 place-items-center rounded-full bg-background shadow"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  </div>
                )
              })}
              <button
                type="button"
                onClick={openFiles}
                aria-label="添加图片"
                className="grid h-14 w-14 shrink-0 place-items-center rounded-lg border-2 border-dashed border-border text-muted-foreground hover:text-foreground"
              >
                <ImagePlus className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={openFolder}
                aria-label="添加文件夹"
                className="grid h-14 w-14 shrink-0 place-items-center rounded-lg border-2 border-dashed border-border text-muted-foreground hover:text-foreground"
              >
                <FolderOpen className="h-5 w-5" />
              </button>
            </div>
          )}
        </div>
        <nav className="flex w-16 shrink-0 flex-col items-center gap-1 border-l border-border py-3">
          {RAIL.map((entry, index) => {
            const Icon = entry.icon
            return (
              <div key={entry.id} className="contents">
                {index === 4 && <div className="my-1 h-px w-8 bg-border" />}
                <button
                  type="button"
                  onClick={() => setPanel(entry.id)}
                  className={`flex w-14 flex-col items-center gap-1 rounded-xl py-2 text-[10px] ${
                    panel === entry.id
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:bg-muted'
                  }`}
                >
                  <Icon
                    className={`h-[18px] w-[18px] ${panel === entry.id ? 'text-primary' : ''}`}
                  />
                  {entry.name}
                </button>
              </div>
            )
          })}
        </nav>
        <aside className="flex w-72 shrink-0 flex-col border-l border-border">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
            {composing ? (
              <ComposePanel mode={panel as ComposeOptions['mode']} />
            ) : (
              <ProcessPanel panel={panel} />
            )}
          </div>
          {!composing && <ExportBar selected={selected} />}
        </aside>
      </div>
    </main>
  )
}

function ProcessPanel({ panel }: { panel: Panel }) {
  const recipe = useProto((s) => s.recipe)
  const setRecipe = useProto((s) => s.setRecipe)
  const lossy = recipe.format !== 'image/png'
  if (panel === 'compress')
    return (
      <>
        <Field label="输出格式">
          <PickSelect
            value={recipe.format}
            options={FORMAT_OPTIONS}
            onChange={(format) => setRecipe({ format })}
            className="h-8 w-full text-[13px]"
          />
        </Field>
        {lossy && (
          <Field label="压缩">
            <Segmented
              size="sm"
              value={recipe.compressMode}
              options={[
                { value: 'quality', label: '按质量' },
                { value: 'target', label: '指定体积' },
              ]}
              onChange={(compressMode) => setRecipe({ compressMode })}
            />
            {recipe.compressMode === 'quality' ? (
              <QualitySlider
                value={recipe.quality}
                onChange={(quality) => setRecipe({ quality })}
              />
            ) : (
              <NumberField
                value={recipe.targetKb}
                suffix="KB"
                onChange={(targetKb) => setRecipe({ targetKb })}
              />
            )}
          </Field>
        )}
      </>
    )
  if (panel === 'resize')
    return (
      <Field label="改尺寸">
        <Segmented
          size="sm"
          value={recipe.resizeMode}
          options={RESIZE_OPTIONS}
          onChange={(resizeMode) => setRecipe({ resizeMode })}
        />
        {recipe.resizeMode !== 'none' && (
          <NumberField
            value={recipe.resizeValue}
            suffix={recipe.resizeMode === 'percent' ? '%' : 'px'}
            onChange={(resizeValue) => setRecipe({ resizeValue })}
          />
        )}
      </Field>
    )
  if (panel === 'crop')
    return (
      <Field label="比例 / 尺寸">
        <div className="grid grid-cols-2 gap-1.5">
          {CROP_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => setRecipe({ crop: option.value, cropX: 0.5, cropY: 0.5 })}
              className={`rounded-lg border px-2 py-1.5 text-left text-xs ${
                recipe.crop === option.value
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </Field>
    )
  return (
    <>
      <Field label="旋转">
        <Segmented
          size="sm"
          value={recipe.rotate}
          options={ROTATE_OPTIONS}
          onChange={(rotate) => setRecipe({ rotate })}
        />
      </Field>
      <Field label="翻转">
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant={recipe.flipH ? 'secondary' : 'outline'}
            onClick={() => setRecipe({ flipH: !recipe.flipH })}
          >
            <FlipHorizontal2 />
            水平
          </Button>
          <Button
            size="sm"
            variant={recipe.flipV ? 'secondary' : 'outline'}
            onClick={() => setRecipe({ flipV: !recipe.flipV })}
          >
            <FlipVertical2 />
            垂直
          </Button>
        </div>
      </Field>
    </>
  )
}

function ProcessStage({ item, panel }: { item: ProtoItem; panel: Panel }) {
  const recipe = useProto((s) => s.recipe)
  const setRecipe = useProto((s) => s.setRecipe)
  const single = useMemo(() => [item], [item])
  const { results } = useProcessed(single, recipe)
  const state = results.get(item.id)
  const done = state?.status === 'done' ? state.result : null
  const [split, setSplit] = useState(0.5)
  const [actual, setActual] = useState(false)
  const frame = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; cropX: number; cropY: number } | null>(null)

  if (state?.status === 'error')
    return <div className="text-sm text-destructive">{state.message}</div>

  if (panel === 'crop') {
    const plan = planGeometry(item.width, item.height, {
      ...recipe,
      rotate: 0,
      flipH: false,
      flipV: false,
    })
    const { sx, sy, sw, sh } = plan.crop
    const onMove = (event: PointerEvent) => {
      const start = drag.current
      const box = frame.current?.getBoundingClientRect()
      if (!start || !box) return
      const slackX = item.width - sw
      const slackY = item.height - sh
      const dx = ((event.clientX - start.x) / box.width) * item.width
      const dy = ((event.clientY - start.y) / box.height) * item.height
      setRecipe({
        cropX: slackX > 0 ? Math.min(1, Math.max(0, start.cropX + dx / slackX)) : 0.5,
        cropY: slackY > 0 ? Math.min(1, Math.max(0, start.cropY + dy / slackY)) : 0.5,
      })
    }
    return (
      <div ref={frame} className="relative inline-block overflow-hidden rounded-md shadow-lg">
        <img
          src={item.url}
          alt=""
          className={`block ${STAGE_MAX_H} max-w-full select-none`}
          draggable={false}
        />
        {recipe.crop !== 'none' && (
          <div
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              drag.current = {
                x: event.clientX,
                y: event.clientY,
                cropX: recipe.cropX,
                cropY: recipe.cropY,
              }
            }}
            onPointerMove={onMove}
            onPointerUp={() => {
              drag.current = null
            }}
            className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
            style={{
              left: `${(sx / item.width) * 100}%`,
              top: `${(sy / item.height) * 100}%`,
              width: `${(sw / item.width) * 100}%`,
              height: `${(sh / item.height) * 100}%`,
            }}
          >
            <span className="absolute left-1/3 top-0 h-full w-px bg-white/40" />
            <span className="absolute left-2/3 top-0 h-full w-px bg-white/40" />
            <span className="absolute left-0 top-1/3 h-px w-full bg-white/40" />
            <span className="absolute left-0 top-2/3 h-px w-full bg-white/40" />
          </div>
        )}
      </div>
    )
  }

  if (!done) return <div className="text-sm text-muted-foreground">处理中…</div>

  const sameShape = panel === 'compress' || panel === 'resize'
  return (
    <div className="flex flex-col items-center gap-3">
      <div
        ref={frame}
        className="relative inline-block touch-none overflow-hidden rounded-md shadow-lg"
        onPointerMove={(event) => {
          if (!sameShape || event.buttons !== 1) return
          const box = event.currentTarget.getBoundingClientRect()
          setSplit(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)))
        }}
      >
        <img
          src={done.url}
          alt=""
          draggable={false}
          style={actual ? { width: done.width, height: done.height } : undefined}
          className={`block select-none ${actual ? 'max-w-none' : `${STAGE_MAX_H} max-w-full`}`}
        />
        {sameShape && (
          <>
            <img
              src={item.url}
              alt=""
              draggable={false}
              className="absolute inset-0 h-full w-full select-none"
              style={{ clipPath: `inset(0 ${100 - split * 100}% 0 0)` }}
            />
            <div
              className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow"
              style={{ left: `${split * 100}%` }}
            >
              <span className="absolute top-1/2 grid h-7 w-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-[10px] text-neutral-900 shadow">
                ⇆
              </span>
            </div>
            <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
              原图
            </span>
            <span className="absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
              处理后
            </span>
          </>
        )}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <Segmented
          size="sm"
          value={actual ? 'actual' : 'fit'}
          options={[
            { value: 'fit', label: '适应' },
            { value: 'actual', label: '1:1' },
          ]}
          onChange={(value) => setActual(value === 'actual')}
        />
      </div>
    </div>
  )
}

function ExportBar({ selected }: { selected: ProtoItem | undefined }) {
  const items = useProto((s) => s.items)
  const recipe = useProto((s) => s.recipe)
  const single = useMemo(() => (selected ? [selected] : []), [selected])
  const { results } = useProcessed(single, recipe)
  const state = selected ? results.get(selected.id) : undefined
  const done = state?.status === 'done' ? state.result : null
  const [exporting, setExporting] = useState(false)

  const exportAll = async (target: 'zip' | 'create') => {
    setExporting(true)
    try {
      const entries = await processAll(items, recipe)
      if (target === 'zip') await downloadAll(entries, 'toolbox.zip')
      else await sendToCreate(entries)
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-3 border-t border-border p-4">
      {selected && done && (
        <div className="space-y-1 rounded-xl bg-muted/50 p-3 text-xs tabular-nums">
          <div className="flex justify-between text-muted-foreground">
            <span>原图</span>
            <span>
              {selected.width}×{selected.height} · {formatBytes(selected.size)}
            </span>
          </div>
          <div className="flex justify-between font-medium">
            <span>处理后</span>
            <span>
              {done.width}×{done.height} · {formatBytes(done.blob.size)}
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-1.5 pt-1">
            <ResultBadges fellBack={done.fellBack} overTarget={done.overTarget} />
            <span
              className={done.blob.size <= selected.size ? 'text-emerald-600' : 'text-amber-600'}
            >
              {savingLabel(selected.size, done.blob.size)}
            </span>
          </div>
        </div>
      )}
      <Button
        variant="outline"
        className="w-full"
        disabled={!done || !selected}
        onClick={() =>
          done && selected && downloadBlob(done.blob, outputName(selected.name, done.blob.type))
        }
      >
        <Download />
        导出这张
      </Button>
      <Button
        className="w-full"
        disabled={items.length === 0 || exporting}
        onClick={() => void exportAll('zip')}
      >
        <Download />
        {exporting ? '处理中…' : `应用到全部并导出（${items.length}）`}
      </Button>
      <Button
        variant="ghost"
        className="w-full"
        disabled={items.length === 0 || exporting}
        onClick={() => void exportAll('create')}
      >
        <SquareArrowOutUpRight />
        全部放入创作输入框
      </Button>
    </div>
  )
}

function ComposePanel({ mode }: { mode: ComposeOptions['mode'] }) {
  const options = useProto((s) => s.composeOptions)
  const setCompose = useProto((s) => s.setCompose)
  return (
    <>
      {mode === 'stitch' && (
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
      )}
      {mode === 'collage' && (
        <Field label="每行">
          <Segmented
            value={options.columns}
            options={[2, 3, 4].map((value) => ({ value, label: `${value}` }))}
            onChange={(columns) => setCompose({ columns })}
          />
        </Field>
      )}
      {mode === 'slice' ? (
        <>
          <Field label="切成">
            <Segmented
              value={`${options.rows}x${options.columns}`}
              options={['3x3', '2x2', '1x3', '3x1'].map((value) => ({
                value,
                label: value.replace('x', '×'),
              }))}
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
      ) : (
        <>
          <Field label="间距">
            <NumberField
              value={options.gap}
              suffix="px"
              onChange={(gap) => setCompose({ gap })}
              className="w-24"
            />
          </Field>
          <Field label="底色">
            <Segmented
              value={options.background}
              options={[
                { value: '#ffffff', label: '白' },
                { value: '#000000', label: '黑' },
                { value: '#f3f4f6', label: '灰' },
              ]}
              onChange={(background) => setCompose({ background })}
            />
          </Field>
        </>
      )}
    </>
  )
}

function ComposeStage({ mode }: { mode: ComposeOptions['mode'] }) {
  const items = useProto((s) => s.items)
  const selectedId = useProto((s) => s.selectedId)
  const options = useProto((s) => s.composeOptions)
  const effective = useMemo<ComposeOptions>(() => ({ ...options, mode }), [options, mode])
  const sources = useMemo(
    () => (mode === 'slice' ? items.filter((item) => item.id === selectedId).slice(0, 1) : items),
    [items, mode, selectedId],
  )
  const state = useComposed(sources.length > 0 ? sources : items.slice(0, 1), effective, true)
  const outputs = state.status === 'done' ? state.outputs : []
  if (state.status === 'error')
    return <div className="text-sm text-destructive">{state.message}</div>
  if (outputs.length === 0) return <div className="text-sm text-muted-foreground">合成中…</div>
  const entries = outputs.map((out, index) => ({
    name: mode === 'slice' ? `slice-${index + 1}.jpg` : `${mode}.jpg`,
    blob: out.blob,
  }))
  return (
    <div className="flex flex-col items-center gap-3">
      {mode === 'slice' ? (
        <div
          className="grid w-[min(32rem,100%)] gap-1"
          style={{ gridTemplateColumns: `repeat(${options.columns}, minmax(0, 1fr))` }}
        >
          {outputs.map((out) => (
            <img key={out.url} src={out.url} alt="" className="w-full" />
          ))}
        </div>
      ) : (
        <img
          src={outputs[0].url}
          alt=""
          className={`${STAGE_MAX_H} max-w-full rounded-md shadow-lg`}
        />
      )}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {outputs.length === 1
          ? `${outputs[0].width}×${outputs[0].height} · ${formatBytes(outputs[0].blob.size)}`
          : `${outputs.length} 张`}
        <Button size="sm" onClick={() => void downloadAll(entries, 'slices.zip')}>
          <Download />
          下载
        </Button>
      </div>
    </div>
  )
}
