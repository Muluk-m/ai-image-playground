// PROTOTYPE — throwaway。变体 B「批处理流水线」：不选工具，右侧一张配方把改尺寸、裁剪、旋转、
// 转格式、压缩串成一趟，左侧队列逐张给出前后对比（BIRME 式）。多图合成放在第二个页签。
// 取舍：一趟出结果、批量最顺手；代价是新手面对一整列参数，单做一件事也要看全表。

import {
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  ImagePlus,
  RotateCcw,
  SquareArrowOutUpRight,
  X,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { downloadBlob } from '../../../lib/downloadImages'
import { APP_MODE_LABELS } from '../../../store'
import { type ComposeOptions, downloadAll, formatBytes, outputName, savingLabel } from './ops'
import {
  CROP_OPTIONS,
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

type Tab = 'batch' | 'compose'

export default function VariantB() {
  const [tab, setTab] = useState<Tab>('batch')
  const items = useProto((s) => s.items)
  const clear = useProto((s) => s.clear)
  const { dropZoneProps, dragging, inputs, openFiles, openFolder } = useIntake()

  return (
    <main {...dropZoneProps} className="flex h-[calc(100dvh-3.5rem)] flex-col">
      {inputs}
      <div className="studio-page-head flex shrink-0 flex-wrap items-center gap-3 border-b border-border py-3 pl-5 pr-16 md:pr-60">
        <h1 className="font-display text-[15px] font-medium">{APP_MODE_LABELS.tools}</h1>
        <Segmented
          value={tab}
          options={[
            { value: 'batch', label: '批量处理' },
            { value: 'compose', label: '拼图合成' },
          ]}
          onChange={setTab}
        />
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
              清空 {items.length} 张
            </Button>
          )}
        </span>
      </div>
      {tab === 'batch' ? (
        <BatchTab dragging={dragging} openFiles={openFiles} openFolder={openFolder} />
      ) : (
        <ComposeTab dragging={dragging} openFiles={openFiles} openFolder={openFolder} />
      )}
    </main>
  )
}

interface IntakeProps {
  dragging: boolean
  openFiles: () => void
  openFolder: () => void
}

function EmptyDrop({ dragging, openFiles, openFolder }: IntakeProps) {
  return (
    <div
      className={`m-5 flex flex-1 flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed ${
        dragging ? 'border-primary bg-primary/5' : 'border-border'
      }`}
    >
      <div className="text-sm text-muted-foreground">拖入图片或文件夹，也可以直接粘贴</div>
      <div className="flex gap-2">
        <Button onClick={openFiles}>选择图片</Button>
        <Button variant="outline" onClick={openFolder}>
          选择文件夹
        </Button>
      </div>
    </div>
  )
}

function Step({ index, title, children }: { index: number; title: string; children: ReactNode }) {
  return (
    <section className="relative pl-8">
      <span className="absolute left-0 top-0 grid h-5 w-5 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
        {index}
      </span>
      <h3 className="mb-2 text-[13px] font-medium leading-5">{title}</h3>
      <div className="space-y-2">{children}</div>
    </section>
  )
}

function RecipePanel() {
  const recipe = useProto((s) => s.recipe)
  const setRecipe = useProto((s) => s.setRecipe)
  const resetRecipe = useProto((s) => s.resetRecipe)
  const lossy = recipe.format !== 'image/png'
  return (
    <aside className="w-80 shrink-0 space-y-6 overflow-y-auto border-l border-border p-5">
      <div className="flex items-center">
        <h2 className="text-sm font-semibold">处理配方</h2>
        <button
          type="button"
          onClick={resetRecipe}
          className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <RotateCcw className="h-3 w-3" />
          重置
        </button>
      </div>
      <Step index={1} title="裁剪">
        <PickSelect
          value={recipe.crop}
          options={CROP_OPTIONS}
          onChange={(crop) => setRecipe({ crop, cropX: 0.5, cropY: 0.5 })}
          className="h-8 w-full text-[13px]"
        />
      </Step>
      <Step index={2} title="尺寸">
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
      </Step>
      <Step index={3} title="旋转与翻转">
        <Segmented
          size="sm"
          value={recipe.rotate}
          options={ROTATE_OPTIONS}
          onChange={(rotate) => setRecipe({ rotate })}
        />
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant={recipe.flipH ? 'secondary' : 'outline'}
            onClick={() => setRecipe({ flipH: !recipe.flipH })}
          >
            水平翻转
          </Button>
          <Button
            size="sm"
            variant={recipe.flipV ? 'secondary' : 'outline'}
            onClick={() => setRecipe({ flipV: !recipe.flipV })}
          >
            垂直翻转
          </Button>
        </div>
      </Step>
      <Step index={4} title="输出格式">
        <PickSelect
          value={recipe.format}
          options={FORMAT_OPTIONS}
          onChange={(format) => setRecipe({ format })}
          className="h-8 w-full text-[13px]"
        />
      </Step>
      <Step index={5} title="压缩">
        <Segmented
          size="sm"
          value={lossy ? recipe.compressMode : 'quality'}
          options={[
            { value: 'quality', label: '按质量' },
            { value: 'target', label: '压到指定体积', disabled: !lossy },
          ]}
          onChange={(compressMode) => setRecipe({ compressMode })}
        />
        {!lossy ? (
          <div className="text-xs text-muted-foreground">PNG 无损</div>
        ) : recipe.compressMode === 'quality' ? (
          <QualitySlider value={recipe.quality} onChange={(quality) => setRecipe({ quality })} />
        ) : (
          <NumberField
            value={recipe.targetKb}
            suffix="KB"
            onChange={(targetKb) => setRecipe({ targetKb })}
          />
        )}
      </Step>
    </aside>
  )
}

function BatchTab(intake: IntakeProps) {
  const items = useProto((s) => s.items)
  const remove = useProto((s) => s.remove)
  const recipe = useProto((s) => s.recipe)
  const { results, busy } = useProcessed(items, recipe)
  const { before, after } = totalBytes(items, results)
  const entries = doneEntries(items, results).map(({ item, result }) => ({
    name: outputName(item.name, result.blob.type),
    blob: result.blob,
  }))

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {items.length === 0 ? (
          <EmptyDrop {...intake} />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <table className="w-full text-[13px]">
              <thead className="sticky top-0 z-10 bg-background text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-5 py-2 text-left font-normal">图片</th>
                  <th className="px-3 py-2 text-left font-normal">尺寸</th>
                  <th className="px-3 py-2 text-left font-normal">体积</th>
                  <th className="px-3 py-2 text-left font-normal">格式</th>
                  <th className="w-20 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const state = results.get(item.id)
                  const done = state?.status === 'done' ? state.result : null
                  return (
                    <tr key={item.id} className="group border-b border-border/60 hover:bg-muted/40">
                      <td className="px-5 py-2">
                        <div className="flex items-center gap-3">
                          <img
                            src={item.url}
                            alt=""
                            className="h-11 w-11 rounded-md object-cover"
                          />
                          {done && (
                            <>
                              <span className="text-muted-foreground">→</span>
                              <img
                                src={done.url}
                                alt=""
                                className="h-11 w-11 rounded-md object-contain ring-1 ring-border"
                              />
                            </>
                          )}
                          <span className="min-w-0 max-w-56 truncate" title={item.name}>
                            {item.name}
                          </span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">
                        {item.width}×{item.height}
                        {done && (
                          <>
                            {' → '}
                            <span className="text-foreground">
                              {done.width}×{done.height}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                        {state?.status === 'error' ? (
                          <span className="text-destructive">{state.message}</span>
                        ) : done ? (
                          <span className="flex items-center gap-1.5">
                            <span className="text-muted-foreground">
                              {formatBytes(item.size)} →
                            </span>
                            {formatBytes(done.blob.size)}
                            <span
                              className={
                                done.blob.size <= item.size ? 'text-emerald-600' : 'text-amber-600'
                              }
                            >
                              {savingLabel(item.size, done.blob.size)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">…</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {done && (
                          <span className="flex flex-wrap items-center gap-1.5">
                            {done.blob.type.split('/')[1]?.toUpperCase()}
                            <ResultBadges fellBack={done.fellBack} overTarget={done.overTarget} />
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className="flex justify-end gap-1 opacity-0 group-hover:opacity-100">
                          {done && (
                            <button
                              type="button"
                              aria-label="下载"
                              onClick={() =>
                                downloadBlob(done.blob, outputName(item.name, done.blob.type))
                              }
                              className="grid h-7 w-7 place-items-center rounded-md hover:bg-background"
                            >
                              <Download className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label="移除"
                            onClick={() => remove(item.id)}
                            className="grid h-7 w-7 place-items-center rounded-md hover:bg-background"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border px-5 py-3">
          <span className="text-sm tabular-nums">
            {busy
              ? '处理中…'
              : before > 0
                ? `${entries.length} 张 · ${formatBytes(before)} → ${formatBytes(after)}（${savingLabel(before, after)}）`
                : ''}
          </span>
          <span className="ml-auto flex gap-2">
            <Button
              variant="outline"
              disabled={entries.length === 0}
              onClick={() => void sendToCreate(entries)}
            >
              <SquareArrowOutUpRight />
              放入创作输入框
            </Button>
            <Button
              disabled={entries.length === 0}
              onClick={() => void downloadAll(entries, 'toolbox.zip')}
            >
              <Download />
              {entries.length > 1 ? `下载 ZIP（${entries.length}）` : '下载'}
            </Button>
          </span>
        </div>
      </div>
      <RecipePanel />
    </div>
  )
}

const MODE_OPTIONS: readonly { value: ComposeOptions['mode']; label: string }[] = [
  { value: 'collage', label: '宫格拼图' },
  { value: 'stitch', label: '长图拼接' },
  { value: 'slice', label: '九宫格切图' },
]

function ComposeTab(intake: IntakeProps) {
  const items = useProto((s) => s.items)
  const move = useProto((s) => s.move)
  const remove = useProto((s) => s.remove)
  const options = useProto((s) => s.composeOptions)
  const setCompose = useProto((s) => s.setCompose)
  const sources = options.mode === 'slice' ? items.slice(0, 1) : items
  const state = useComposed(sources, options, true)
  const outputs = state.status === 'done' ? state.outputs : []
  const entries = outputs.map((out, index) => ({
    name: options.mode === 'slice' ? `slice-${index + 1}.jpg` : `${options.mode}.jpg`,
    blob: out.blob,
  }))

  if (items.length === 0)
    return (
      <div className="flex min-h-0 flex-1">
        <EmptyDrop {...intake} />
      </div>
    )

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-border p-3">
          {items.map((item, index) => (
            <div
              key={item.id}
              className={`group relative shrink-0 ${options.mode === 'slice' && index > 0 ? 'opacity-40' : ''}`}
            >
              <img
                src={item.url}
                alt=""
                className="h-16 w-16 rounded-lg object-cover ring-1 ring-border"
              />
              <span className="absolute left-1 top-1 rounded bg-background/90 px-1 text-[10px] font-semibold">
                {index + 1}
              </span>
              <span className="absolute inset-x-0 bottom-0 flex justify-between rounded-b-lg bg-background/90 opacity-0 group-hover:opacity-100">
                <button type="button" onClick={() => move(item.id, -1)} aria-label="前移">
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => remove(item.id)} aria-label="移除">
                  <X className="h-3.5 w-3.5" />
                </button>
                <button type="button" onClick={() => move(item.id, 1)} aria-label="后移">
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-muted/30 p-6">
          {state.status === 'error' ? (
            <div className="grid h-full place-items-center text-sm text-destructive">
              {state.message}
            </div>
          ) : options.mode === 'slice' ? (
            <div
              className="mx-auto grid max-w-lg gap-1"
              style={{ gridTemplateColumns: `repeat(${options.columns}, minmax(0, 1fr))` }}
            >
              {outputs.map((out) => (
                <img key={out.url} src={out.url} alt="" className="w-full" />
              ))}
            </div>
          ) : outputs[0] ? (
            <img
              src={outputs[0].url}
              alt=""
              className="mx-auto max-h-full w-auto rounded-md shadow-lg"
            />
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-3 border-t border-border px-5 py-3">
          <span className="text-sm tabular-nums text-muted-foreground">
            {outputs.length === 1
              ? `${outputs[0].width}×${outputs[0].height} · ${formatBytes(outputs[0].blob.size)}`
              : outputs.length > 1
                ? `${outputs.length} 张`
                : ''}
          </span>
          <Button
            className="ml-auto"
            disabled={entries.length === 0}
            onClick={() => void downloadAll(entries, 'slices.zip')}
          >
            <Download />
            下载
          </Button>
        </div>
      </div>
      <aside className="w-72 shrink-0 space-y-5 overflow-y-auto border-l border-border p-5">
        <PickSelect
          value={options.mode}
          options={MODE_OPTIONS}
          onChange={(mode) => setCompose({ mode })}
          className="h-9 w-full text-[13px]"
        />
        {options.mode === 'stitch' && (
          <Segmented
            value={options.direction}
            options={[
              { value: 'vertical', label: '竖拼' },
              { value: 'horizontal', label: '横拼' },
            ]}
            onChange={(direction) => setCompose({ direction })}
          />
        )}
        {options.mode === 'collage' && (
          <Segmented
            value={options.columns}
            options={[2, 3, 4].map((value) => ({ value, label: `每行 ${value}` }))}
            onChange={(columns) => setCompose({ columns })}
          />
        )}
        {options.mode === 'slice' ? (
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
        ) : (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            间距
            <NumberField
              value={options.gap}
              suffix="px"
              onChange={(gap) => setCompose({ gap })}
              className="w-24"
            />
          </div>
        )}
      </aside>
    </div>
  )
}
