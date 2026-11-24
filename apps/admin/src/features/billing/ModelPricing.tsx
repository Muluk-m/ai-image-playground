import { zodResolver } from '@hookform/resolvers/zod'
import type { Catalog, ModelPrice } from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
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
        <FormItem className="space-y-1.5">
          <FormLabel className="block whitespace-nowrap text-xs font-medium text-muted-foreground">
            {label}
          </FormLabel>
          <FormControl>
            <Input
              type="number"
              min={name === 'cachedInputPercent' ? 0 : 1}
              max={max}
              step="1"
              className="h-9 font-mono text-sm tabular-nums"
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
  onClose?: () => void
}) {
  const queryClient = useQueryClient()
  const chat = isChatPrice(price)
  const {
    credits_per_image: creditsPerImage,
    output_credits_per_unit: outputCreditsPerUnit,
    output_reserve_tokens: outputReserveTokens,
    cached_input_price_percent: cachedInputPricePercent,
  } = price
  const values = useMemo<ModelPriceForm>(
    () => ({
      amount: String(creditsPerImage),
      outputAmount: outputCreditsPerUnit === null ? '' : String(outputCreditsPerUnit),
      reserveTokens: outputReserveTokens === null ? '' : String(outputReserveTokens),
      cachedInputPercent: String(cachedInputPricePercent ?? 0),
    }),
    [creditsPerImage, outputCreditsPerUnit, outputReserveTokens, cachedInputPricePercent],
  )
  const form = useForm<ModelPriceForm>({
    resolver: zodResolver(chat ? chatPriceSchema : modelPriceSchema),
    defaultValues: values,
  })

  const isDirtyRef = useRef(false)
  isDirtyRef.current = form.formState.isDirty

  useEffect(() => {
    if (!isDirtyRef.current) {
      form.reset(values)
    }
  }, [form, values])

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
    onSuccess: async (_data, submitted) => {
      form.reset(submitted)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: catalogKey }),
        queryClient.invalidateQueries({ queryKey: ['private-billing', 'account'] }),
      ])
      onClose?.()
    },
  })

  return (
    <Form {...form}>
      <form
        noValidate
        onChange={() => {
          if (mutation.isSuccess || mutation.isError) mutation.reset()
        }}
        onSubmit={form.handleSubmit((input) => mutation.mutate(input))}
      >
        <fieldset disabled={mutation.isPending} className="space-y-3">
          {isNew ? (
            <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              尚未配置积分单价，确认建价后立即生效。
            </p>
          ) : null}

          <div className={chat ? 'grid grid-cols-2 gap-3' : 'max-w-[240px]'}>
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

          <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
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
              {onClose ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={mutation.isPending}
                  onClick={onClose}
                >
                  取消
                </Button>
              ) : form.formState.isDirty ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={mutation.isPending}
                  onClick={() => {
                    mutation.reset()
                    form.reset(values)
                  }}
                >
                  重置
                </Button>
              ) : null}
              <Button
                type="submit"
                size="sm"
                disabled={(!isNew && !form.formState.isDirty) || mutation.isPending}
              >
                {isNew ? '确认建价' : '保存定价'}
              </Button>
            </div>
          </div>
        </fieldset>
      </form>
    </Form>
  )
}

/** 「模型与定价」每一行的单价摘要，或在检视抽屉内直接编辑定价。 */
export function ModelPricing({
  model,
  kind = 'image',
  mode = 'summary',
  onEdit,
}: {
  model: string
  kind?: ModelPriceKind
  mode?: 'summary' | 'editor'
  onEdit?: () => void
}) {
  const [inlineEditing, setInlineEditing] = useState(false)
  const fallbackPrice = useMemo(() => defaultModelPriceForKind(model, kind), [model, kind])
  const catalog = useQuery({
    queryKey: catalogKey,
    queryFn: () => apiClient.get<Catalog>('/api/private/billing/catalog'),
  })

  if (catalog.isPending) return <span className="text-xs text-muted-foreground">读取中…</span>
  if (catalog.isError) return <p className="text-xs text-danger">单价读取失败</p>

  const creditsPerYuan = catalog.data.recharge_pricing?.credits_per_yuan
  const price = catalog.data.model_prices.find((entry) => entry.model === model)
  const activePrice = price ?? fallbackPrice

  if (mode === 'editor') {
    return (
      <PriceEditor
        key={`${model}:${kind}`}
        price={activePrice}
        isNew={!price}
        creditsPerYuan={creditsPerYuan}
      />
    )
  }

  if (inlineEditing && !onEdit) {
    return (
      <div className="rounded-lg border bg-muted/30 p-3">
        <PriceEditor
          key={`${model}:${kind}:${price ? price.updated_at : 'new'}`}
          price={activePrice}
          isNew={!price}
          creditsPerYuan={creditsPerYuan}
          onClose={() => setInlineEditing(false)}
        />
      </div>
    )
  }

  const triggerEdit = () => {
    if (onEdit) onEdit()
    else setInlineEditing(true)
  }

  if (!price) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-warning">
          <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
          未定价
        </span>
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="shrink-0"
          onClick={(event) => {
            event.stopPropagation()
            triggerEdit()
          }}
        >
          定价
        </Button>
      </div>
    )
  }

  if (isChatPrice(price)) {
    const inYuan = formatCreditsAsYuan(price.credits_per_image, creditsPerYuan)
    const outYuan = formatCreditsAsYuan(price.output_credits_per_unit ?? 0, creditsPerYuan)
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="whitespace-nowrap font-mono text-xs tabular-nums">
            <span className="font-medium text-foreground">
              入 {price.credits_per_image} · 出 {price.output_credits_per_unit ?? '—'}
            </span>{' '}
            <span className="font-sans text-muted-foreground">分/千tok</span>
          </div>
          <div className="truncate text-xs text-muted-foreground">
            缓存 {price.cached_input_price_percent ?? 0}% · 预留{' '}
            <span className="font-mono tabular-nums">{price.output_reserve_tokens ?? 0}</span>
            {inYuan && outYuan ? (
              <span className="ml-1 font-mono tabular-nums">
                · {inYuan}/{outYuan}
              </span>
            ) : null}
          </div>
        </div>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="shrink-0"
          onClick={(event) => {
            event.stopPropagation()
            triggerEdit()
          }}
        >
          改价
        </Button>
      </div>
    )
  }

  const yuan = formatCreditsAsYuan(price.credits_per_image, creditsPerYuan)
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <div className="whitespace-nowrap font-mono text-xs tabular-nums">
          <span className="font-medium text-foreground">{price.credits_per_image}</span>{' '}
          <span className="font-sans text-muted-foreground">{SHORT_UNIT_LABELS[price.unit]}</span>
        </div>
        {yuan ? (
          <div className="font-mono text-xs tabular-nums text-muted-foreground">≈ {yuan}</div>
        ) : null}
      </div>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        className="shrink-0"
        onClick={(event) => {
          event.stopPropagation()
          triggerEdit()
        }}
      >
        改价
      </Button>
    </div>
  )
}
