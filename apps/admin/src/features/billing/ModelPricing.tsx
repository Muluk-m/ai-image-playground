import { zodResolver } from '@hookform/resolvers/zod'
import type { Catalog, ModelPrice } from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
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
  isChatPrice,
  type ModelPriceForm,
  modelPriceFormValues,
  modelPriceRequest,
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
              {...field}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}

function PriceEditor({ price }: { price: ModelPrice }) {
  const queryClient = useQueryClient()
  const chat = isChatPrice(price)
  const values = modelPriceFormValues(price)
  const form = useForm<ModelPriceForm>({
    resolver: zodResolver(chat ? chatPriceSchema : modelPriceSchema),
    defaultValues: values,
  })
  useEffect(() => form.reset(values), [price, form])
  const mutation = useMutation({
    mutationFn: (input: ModelPriceForm) =>
      apiClient.put(
        `/api/private/billing/models/${encodeURIComponent(price.model)}`,
        modelPriceRequest(price, input),
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: catalogKey }),
        queryClient.invalidateQueries({ queryKey: ['private-billing', 'account'] }),
      ]),
  })
  return (
    <Form {...form}>
      <form
        className="flex flex-wrap items-end gap-3"
        noValidate
        onChange={() => mutation.reset()}
        onSubmit={form.handleSubmit((input) => mutation.mutate(input))}
      >
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
        <div className="flex h-9 items-center gap-3">
          <Button
            type="submit"
            variant="outline"
            disabled={!form.formState.isDirty || mutation.isPending}
          >
            保存
          </Button>
          <SaveStatus
            pending={mutation.isPending}
            success={mutation.isSuccess}
            error={mutation.error}
          />
        </div>
      </form>
    </Form>
  )
}

/** 「模型」页每一行的单价。上下架在公开侧，这里只管价格；单价表里没有这一行就说未定价。 */
export function ModelPricing({ model }: { model: string }) {
  const catalog = useQuery({
    queryKey: catalogKey,
    queryFn: () => apiClient.get<Catalog>('/api/private/billing/catalog'),
  })
  if (catalog.isPending) return null
  if (catalog.isError) return <p className="pt-2 text-xs text-destructive">单价读取失败</p>
  const price = catalog.data.model_prices.find((entry) => entry.model === model)
  if (!price) return <p className="pt-2 text-xs text-muted-foreground">未定价</p>
  return <PriceEditor price={price} />
}
