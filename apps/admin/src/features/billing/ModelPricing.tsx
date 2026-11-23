import { zodResolver } from '@hookform/resolvers/zod'
import type { Catalog, ModelPrice } from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { apiClient } from '../../lib/private-host'
import {
  Button,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
} from '../../lib/private-host-ui'
import {
  CHAT_PRICE_LABELS,
  defaultModelPriceForKind,
  formatCreditsAsYuan,
  isChatPrice,
  type ModelPriceForm,
  type ModelPriceKind,
  modelPriceFormValues,
  modelPriceRequest,
  SHORT_UNIT_LABELS,
  UNIT_LABELS,
} from './model-price'
import { SaveStatus } from './SettingsPanel'

const requiredInteger = z.string().trim().regex(/^\d+$/, '请输入整数')
const positiveInteger = requiredInteger.refine((value) => Number(value) > 0, '必须大于 0')
const modelPriceSchema = z.object({
  amount: positiveInteger,
  outputAmount: z.string(),
  reserveTokens: z.string(),
  cachedInputPercent: z.string(),
})
const chatPriceSchema = modelPriceSchema.extend({
  outputAmount: positiveInteger,
  reserveTokens: positiveInteger,
  cachedInputPercent: requiredInteger.refine((value) => Number(value) <= 100, '必须在 0–100 之间'),
})

const catalogKey = ['private-billing', 'catalog']

function PriceField({
  name,
  label,
  max,
}: {
  name: keyof ModelPriceForm
  label: string
  max?: number
}) {
  return (
    <FormField
      name={name}
      render={({ field }) => (
        <FormItem className="w-36 space-y-1">
          <FormLabel className="text-xs text-muted-foreground">{label}</FormLabel>
          <FormControl>
            <Input
              type="number"
              min={name === 'cachedInputPercent' ? 0 : 1}
              max={max}
              step="1"
              className="h-8 font-mono text-xs"
              {...field}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

function PriceEditor({
  price,
  isNew,
  creditsPerYuan,
  onClose,
}: {
  price: ModelPrice
  isNew: boolean
  creditsPerYuan?: number
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const chat = isChatPrice(price)
  const values = modelPriceFormValues(price)
  const form = useForm<ModelPriceForm>({
    resolver: zodResolver(chat ? chatPriceSchema : modelPriceSchema),
    defaultValues: values,
  })
  const watchedAmount = Number(form.watch('amount'))
  const watchedOut = Number(form.watch('outputAmount'))
  const inYuan = formatCreditsAsYuan(watchedAmount, creditsPerYuan)
  const outYuan = chat ? formatCreditsAsYuan(watchedOut, creditsPerYuan) : null

  const mutation = useMutation({
    mutationFn: (input: ModelPriceForm) =>
      apiClient.put(
        `/api/private/billing/models/${encodeURIComponent(price.model)}`,
        modelPriceRequest(price, input),
      ),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: catalogKey }),
        queryClient.invalidateQueries({ queryKey: ['private-billing', 'account'] }),
      ])
      onClose()
    },
  })

  return (
    <Form {...form}>
      <form
        className="space-y-2.5 rounded-lg border bg-muted/30 p-3"
        noValidate
        onChange={() => mutation.reset()}
        onSubmit={form.handleSubmit((input) => mutation.mutate(input))}
      >
        <div className="flex flex-wrap items-end gap-2.5">
          <PriceField name="amount" label={UNIT_LABELS[price.unit]} />
          {chat ? (
            <>
              <PriceField name="outputAmount" label={CHAT_PRICE_LABELS.outputAmount} />
              <PriceField
                name="cachedInputPercent"
                label={CHAT_PRICE_LABELS.cachedInputPercent}
                max={100}
              />
              <PriceField name="reserveTokens" label={CHAT_PRICE_LABELS.reserveTokens} />
            </>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <span className="font-mono text-xs text-muted-foreground">
            {inYuan
              ? chat && outYuan
                ? `折合输入 ≈ ${inYuan}/千tok · 输出 ≈ ${outYuan}/千tok`
                : `折合单价 ≈ ${inYuan}`
              : '按整数积分结算'}
          </span>
          <div className="flex items-center gap-2">
            <SaveStatus
              pending={mutation.isPending}
              success={mutation.isSuccess}
              error={mutation.error}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={mutation.isPending}
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={(!isNew && !form.formState.isDirty) || mutation.isPending}
            >
              {isNew ? '确认建价' : '保存'}
            </Button>
          </div>
        </div>
      </form>
    </Form>
  )
}

/** 「模型与定价」每一行的单价摘要与编辑；支持为尚未入库的新模型初始化积分单价。 */
export function ModelPricing({ model, kind = 'image' }: { model: string; kind?: ModelPriceKind }) {
  const [editing, setEditing] = useState(false)
  const fallbackPrice = useMemo(() => defaultModelPriceForKind(model, kind), [model, kind])
  const catalog = useQuery({
    queryKey: catalogKey,
    queryFn: () => apiClient.get<Catalog>('/api/private/billing/catalog'),
  })

  if (catalog.isPending) return <span className="text-xs text-muted-foreground">读取中…</span>
  if (catalog.isError) return <p className="text-xs text-danger">单价读取失败</p>

  const creditsPerYuan = catalog.data.recharge_pricing?.credits_per_yuan
  const price = catalog.data.model_prices.find((entry) => entry.model === model)

  if (editing) {
    const activePrice = price ?? fallbackPrice
    return (
      <PriceEditor
        key={`${model}:${kind}:${price ? price.updated_at : 'new'}`}
        price={activePrice}
        isNew={!price}
        creditsPerYuan={creditsPerYuan}
        onClose={() => setEditing(false)}
      />
    )
  }

  if (!price) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-warning">
          <span className="size-2 rounded-full bg-warning" aria-hidden />
          未定价
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
          初始化定价
        </Button>
      </div>
    )
  }

  if (isChatPrice(price)) {
    const inYuan = formatCreditsAsYuan(price.credits_per_image, creditsPerYuan)
    const outYuan = formatCreditsAsYuan(price.output_credits_per_unit ?? 0, creditsPerYuan)
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <div className="font-mono text-xs">
            <span className="font-medium text-foreground">
              入 {price.credits_per_image} · 出 {price.output_credits_per_unit ?? '—'}
            </span>{' '}
            <span className="font-sans text-muted-foreground">积分/千tok</span>
          </div>
          <div className="text-xs text-muted-foreground">
            缓存 {price.cached_input_price_percent ?? 0}% · 预留{' '}
            <span className="font-mono">{price.output_reserve_tokens ?? 0}</span>
            {inYuan && outYuan ? (
              <span className="ml-1.5 font-mono">
                · ≈ {inYuan}/{outYuan}
              </span>
            ) : null}
          </div>
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
          改价
        </Button>
      </div>
    )
  }

  const yuan = formatCreditsAsYuan(price.credits_per_image, creditsPerYuan)
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="space-y-0.5">
        <div className="font-mono text-xs">
          <span className="font-medium text-foreground">{price.credits_per_image}</span>{' '}
          <span className="font-sans text-muted-foreground">{SHORT_UNIT_LABELS[price.unit]}</span>
        </div>
        {yuan ? <div className="font-mono text-xs text-muted-foreground">≈ {yuan}</div> : null}
      </div>
      <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(true)}>
        改价
      </Button>
    </div>
  )
}
