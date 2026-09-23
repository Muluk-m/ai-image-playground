import type {
  InspirationAdminItem,
  InspirationCategory,
  InspirationKind,
  InspirationParams,
  InspirationWriteInput,
} from '@image-playground/shared'
import { INSPIRATION_KINDS } from '@image-playground/shared'
import { Loader2, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'

import { ErrorState, PendingState } from '@/components/Page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { fuzzyTime, isoTime } from '@/lib/format'
import {
  inspirationErrorMessage,
  useAgentSkillCatalog,
  useCreateInspiration,
  useDeleteInspiration,
  useInspiration,
  useSetInspirationStatus,
  useUpdateInspiration,
} from '@/lib/inspirations'
import { AssetPicker, ReferenceImageFields } from './AssetPicker'
import { ConfirmDialog } from './ConfirmDialog'
import {
  emptyDraft,
  KIND_LABEL,
  PROVIDER_OPTIONS,
  promptSlots,
  QUALITY_OPTIONS,
  STATUS_BADGE,
  STATUS_LABEL,
  toWriteInput,
} from './constants'
import { SitePreview } from './SitePreview'

interface InspirationDrawerProps {
  /** 打开哪一条；null 且 creating=false 时抽屉关着。 */
  itemId: string | null
  creating: boolean
  categories: InspirationCategory[]
  onClose: () => void
  /** 新建成功后把抽屉换成「编辑这条」，URL 也跟着换成 item=<id>。 */
  onCreated: (id: string) => void
}

export function InspirationDrawer({
  itemId,
  creating,
  categories,
  onClose,
  onCreated,
}: InspirationDrawerProps) {
  const detail = useInspiration(creating ? null : itemId)

  return (
    <Sheet
      open={creating || itemId !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b px-4 py-4 sm:px-6">
          <SheetTitle>
            {creating ? '新建灵感条目' : (detail.data?.title ?? '编辑灵感条目')}
          </SheetTitle>
          <SheetDescription>关掉抽屉会回到列表，筛选和滚动位置都还在。</SheetDescription>
        </SheetHeader>
        {creating ? (
          <InspirationEditor
            item={null}
            categories={categories}
            onClose={onClose}
            onCreated={onCreated}
          />
        ) : detail.isPending ? (
          <PendingState label="加载条目" />
        ) : detail.isError ? (
          <ErrorState label="加载条目失败" error={detail.error} />
        ) : (
          <InspirationEditor
            key={detail.data.id}
            item={detail.data}
            categories={categories}
            onClose={onClose}
            onCreated={onCreated}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

type PendingConfirm = 'publish' | 'archive' | 'delete'

const CONFIRM_COPY: Record<PendingConfirm, { title: string; description: string; label: string }> =
  {
    publish: {
      title: '发布到主站？',
      description: '发布后主站探索页立刻能看到这一条，所有用户都能玩同款。会先保存当前编辑。',
      label: '发布',
    },
    archive: {
      title: '从主站下架？',
      description: '下架只把它从主站清单里摘掉，记录和数据都留着，随时可以再发布。',
      label: '下架',
    },
    delete: {
      title: '删除这条灵感？',
      description: '记录会被永久删除，不能撤销。已发布的条目要先下架。',
      label: '删除',
    },
  }

function InspirationEditor({
  item,
  categories,
  onClose,
  onCreated,
}: {
  item: InspirationAdminItem | null
  categories: InspirationCategory[]
  onClose: () => void
  onCreated: (id: string) => void
}) {
  const [draft, setDraft] = useState<InspirationWriteInput>(() =>
    item ? toWriteInput(item) : emptyDraft(categories[0]?.id ?? ''),
  )
  const [tagsText, setTagsText] = useState(() => (item?.tags ?? []).join(', '))
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<PendingConfirm | null>(null)
  // 新建成功后先别急着换抽屉：紧跟着的发布校验可能被拒，错误得有地方显示。
  // 等这一轮动作整个做完才 onCreated（它会改 URL 并按新 id 重挂编辑器）。
  const [createdId, setCreatedId] = useState<string | null>(null)
  const skills = useAgentSkillCatalog()
  const create = useCreateInspiration()
  const update = useUpdateInspiration()
  const remove = useDeleteInspiration()
  const setStatus = useSetInspirationStatus()
  const busy = create.isPending || update.isPending || remove.isPending || setStatus.isPending
  const savedId = item?.id ?? createdId
  // 服务端此刻的状态：新建出来的条目一定是草稿。
  const savedStatus = item?.status ?? (createdId ? 'draft' : null)

  function patch(next: Partial<InspirationWriteInput>): void {
    setDraft((current) => ({ ...current, ...next }))
  }

  function patchParams(next: Partial<InspirationParams>): void {
    setDraft((current) => ({ ...current, params: { ...current.params, ...next } }))
  }

  /** 保存返回条目 id；失败时返回 null，错误已经写进提示栏。 */
  async function save(): Promise<string | null> {
    setError(null)
    try {
      if (savedId) {
        await update.mutateAsync({ ...draft, id: savedId })
        return savedId
      }
      const created = await create.mutateAsync(draft)
      setCreatedId(created.item.id)
      return created.item.id
    } catch (saveError) {
      setError(inspirationErrorMessage(saveError))
      return null
    }
  }

  async function saveAsDraft(): Promise<void> {
    const id = await save()
    if (!id) return
    // 新建出来就是草稿；已发布 / 已下架的条目点「存草稿」才需要再退一次状态。
    if (savedStatus && savedStatus !== 'draft') {
      try {
        await setStatus.mutateAsync({ id, status: 'draft' })
      } catch (statusError) {
        setError(inspirationErrorMessage(statusError))
        return
      }
    }
    if (!item) onCreated(id)
  }

  async function runConfirmed(): Promise<void> {
    const action = confirming
    setConfirming(null)
    if (!action) return
    setError(null)
    try {
      if (action === 'publish') {
        const id = await save()
        if (!id) return
        await setStatus.mutateAsync({ id, status: 'published' })
        if (!item) onCreated(id)
        return
      }
      if (!savedId) return
      if (action === 'archive') {
        await setStatus.mutateAsync({ id: savedId, status: 'archived' })
        return
      }
      await remove.mutateAsync(savedId)
      onClose()
    } catch (actionError) {
      setError(inspirationErrorMessage(actionError))
    }
  }

  const slots = promptSlots(draft.prompt)
  const categoryName =
    categories.find((category) => category.id === draft.categoryId)?.name ?? draft.categoryId

  return (
    <>
      <Tabs defaultValue="content" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="mx-4 mt-4 grid h-auto grid-cols-2 gap-1 sm:mx-6 sm:grid-cols-4">
          <TabsTrigger value="content">内容</TabsTrigger>
          <TabsTrigger value="params">参数与参考图</TabsTrigger>
          <TabsTrigger value="preview">主站预览</TabsTrigger>
          <TabsTrigger value="history">发布历史</TabsTrigger>
        </TabsList>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <TabsContent value="content" className="mt-0 space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="id" hint={savedId ? '已创建，不可改' : '主站置顶用的稳定 key'}>
                <Input
                  value={draft.id}
                  readOnly={savedId !== null}
                  disabled={savedId !== null}
                  placeholder="awesome-42"
                  className="font-mono text-xs"
                  onChange={(event) => patch({ id: event.target.value })}
                />
              </Field>
              <Field label="排序" hint="小的排前面">
                <Input
                  type="number"
                  value={draft.sort}
                  onChange={(event) => patch({ sort: Number(event.target.value) || 0 })}
                />
              </Field>
            </div>
            <Field label="标题">
              <Input
                value={draft.title}
                onChange={(event) => patch({ title: event.target.value })}
              />
            </Field>
            <Field label="说明">
              <Textarea
                rows={2}
                value={draft.description ?? ''}
                onChange={(event) => patch({ description: event.target.value || null })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="分类">
                <Select
                  value={draft.categoryId}
                  onValueChange={(next) => patch({ categoryId: next })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择分类" />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="类型">
                <Select
                  value={draft.kind}
                  onValueChange={(next) => patch({ kind: next as InspirationKind })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INSPIRATION_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {KIND_LABEL[kind]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {draft.kind === 'skill' ? (
              <Field label="关联技能" hint="正文随镜像发布，这里只挑">
                <Select
                  value={draft.skillName ?? ''}
                  onValueChange={(next) => patch({ skillName: next })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="选择部署技能" />
                  </SelectTrigger>
                  <SelectContent>
                    {(skills.data ?? []).map((skill) => (
                      <SelectItem key={skill.name} value={skill.name}>
                        /{skill.name} · {skill.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {skills.isError ? (
                  <p className="mt-1 text-xs text-destructive">技能目录读取失败，发布会被拒</p>
                ) : null}
              </Field>
            ) : null}
            <Field
              label="提示词"
              hint={draft.kind === 'template' ? '用 {槽位} 让用户填' : undefined}
            >
              <Textarea
                rows={8}
                value={draft.prompt}
                onChange={(event) => patch({ prompt: event.target.value })}
                className="font-mono text-xs leading-5"
              />
              {draft.kind === 'template' ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {slots.length ? (
                    slots.map((slot) => (
                      <Badge key={slot} variant="info">
                        {slot}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-xs text-destructive">
                      还没有 {'{槽位}'}，模板发布会被拒
                    </span>
                  )}
                </div>
              ) : null}
            </Field>
            <Field label="标签" hint="逗号分隔">
              <Input
                value={tagsText}
                onChange={(event) => {
                  setTagsText(event.target.value)
                  patch({
                    tags: event.target.value
                      .split(/[,，]/)
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  })
                }}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="作者">
                <Input
                  value={draft.author ?? ''}
                  onChange={(event) => patch({ author: event.target.value || null })}
                />
              </Field>
              <Field label="来源链接">
                <Input
                  value={draft.sourceUrl ?? ''}
                  placeholder="https://…"
                  onChange={(event) => patch({ sourceUrl: event.target.value || null })}
                />
              </Field>
            </div>
            <label className="flex items-center justify-between rounded-lg border p-3">
              <span>
                <strong className="block text-sm">首页推荐位</strong>
                <span className="text-xs text-muted-foreground">
                  进创作页冷启动卡片与首页 chips 的候选集
                </span>
              </span>
              <Switch
                checked={draft.featured}
                onCheckedChange={(next) => patch({ featured: next })}
              />
            </label>
          </TabsContent>

          <TabsContent value="params" className="mt-0 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="推荐 provider">
                <Select
                  value={draft.recommendedProvider}
                  onValueChange={(next) => patch({ recommendedProvider: next })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDER_OPTIONS.map((provider) => (
                      <SelectItem key={provider.value} value={provider.value}>
                        {provider.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="推荐模型" hint="必须是本部署在服务的模型">
                <Input
                  value={draft.recommendedModel}
                  placeholder="gpt-image-1"
                  onChange={(event) => patch({ recommendedModel: event.target.value })}
                />
              </Field>
              <Field label="尺寸">
                <Input
                  value={draft.params.size}
                  placeholder="1024x1024"
                  onChange={(event) => patchParams({ size: event.target.value })}
                />
              </Field>
              <Field label="质量">
                <Select
                  value={draft.params.quality ?? 'unset'}
                  onValueChange={(next) =>
                    patchParams({
                      quality:
                        next === 'unset' ? undefined : (next as InspirationParams['quality']),
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unset">不指定</SelectItem>
                    {QUALITY_OPTIONS.map((quality) => (
                      <SelectItem key={quality} value={quality}>
                        {quality}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="张数" hint="留空跟随用户设置">
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={draft.params.n ?? ''}
                  onChange={(event) =>
                    patchParams({
                      n: event.target.value ? Number(event.target.value) : undefined,
                    })
                  }
                />
              </Field>
            </div>
            <AssetPicker
              label="封面"
              hint="主站卡片用这张"
              value={draft.coverKey}
              onChange={(next) => patch({ coverKey: next })}
            />
            <AssetPicker
              label="原图"
              hint="可选，详情页点开看大图"
              value={draft.imageKey ?? ''}
              clearable
              onChange={(next) => patch({ imageKey: next || null })}
            />
            <ReferenceImageFields
              value={draft.referenceImages}
              onChange={(next) => patch({ referenceImages: next })}
            />
          </TabsContent>

          <TabsContent value="preview" className="mt-0">
            <SitePreview draft={draft} categoryName={categoryName} />
          </TabsContent>

          <TabsContent value="history" className="mt-0 space-y-4">
            {item ? (
              <>
                <dl className="divide-y rounded-lg border text-sm">
                  <HistoryRow label="当前状态">
                    <Badge variant={STATUS_BADGE[item.status]}>{STATUS_LABEL[item.status]}</Badge>
                  </HistoryRow>
                  <HistoryRow label="首次发布">
                    {item.publishedAt ? isoTime(item.publishedAt) : '从未发布'}
                  </HistoryRow>
                  <HistoryRow label="最近修改">
                    {isoTime(item.updatedAt)}
                    <span className="ml-2 text-muted-foreground">{fuzzyTime(item.updatedAt)}</span>
                  </HistoryRow>
                  <HistoryRow label="修改人">{item.updatedBy}</HistoryRow>
                  <HistoryRow label="创建时间">{isoTime(item.createdAt)}</HistoryRow>
                </dl>
                <p className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
                  没有逐条发布历史接口：条目只记录当前状态和最近一次修改，上面是这条记录自己带的字段。
                  谁在什么时候发布 / 下架，去「审计」模块按 inspiration 查。
                </p>
              </>
            ) : (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                {createdId
                  ? '已存为草稿；关掉抽屉重新打开，这里就有完整的状态与修改记录。'
                  : '条目还没创建，存过草稿后这里才有状态与修改记录。'}
              </p>
            )}
          </TabsContent>
        </div>
      </Tabs>

      <div className="border-t px-4 py-3 sm:px-6">
        {error ? <p className="mb-2 text-sm text-destructive">{error}</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={!savedId || busy}
            onClick={() => setConfirming('delete')}
          >
            <Trash2 className="mr-1 size-4" />
            删除
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {busy ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void saveAsDraft()}>
              存草稿
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || savedStatus !== 'published'}
              title={savedStatus === 'published' ? undefined : '只有已发布的条目需要下架'}
              onClick={() => setConfirming('archive')}
            >
              下架
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setConfirming('publish')}>
              发布到主站
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirming !== null}
        title={confirming ? CONFIRM_COPY[confirming].title : ''}
        description={confirming ? CONFIRM_COPY[confirming].description : ''}
        confirmLabel={confirming ? CONFIRM_COPY[confirming].label : ''}
        destructive={confirming !== 'publish'}
        pending={busy}
        onConfirm={() => void runConfirmed()}
        onOpenChange={(next) => {
          if (!next) setConfirming(null)
        }}
      />
    </>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
      </span>
      {children}
    </label>
  )
}

function HistoryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  )
}
