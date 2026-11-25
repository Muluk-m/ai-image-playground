import { zodResolver } from '@hookform/resolvers/zod'
import type {
  AccountSnapshot,
  BillingPeriodMonths,
  Catalog,
  CreditLedgerEntryType,
  LedgerEntry,
  LedgerPage,
  OperatorAccountSnapshot,
  Plan,
} from '@image-playground/shared'
import { MAX_CREDIT_BALANCE } from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw } from 'lucide-react'
import { type ReactNode, type Ref, useEffect, useId, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { z } from 'zod'
import { ApiError, apiClient } from '../../lib/private-host'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../lib/private-host-ui'
import { AccountFacts } from './account-facts'
import { ChatUsageFacts, useChatUsage } from './chat-usage'
import { visibleLedger } from './ledger-display'
import {
  credits,
  dateTime,
  ErrorText,
  money,
  parseLocalInput,
  Section,
  toLocalInput,
} from './shared'

const LEDGER_LABELS: Record<CreditLedgerEntryType, string> = {
  grant: '套餐发放',
  recharge: '充值 / 补发',
  hold: '任务预扣',
  release: '任务退回',
  commit: '任务结算',
  expire: '到期清零',
  adjustment: '人工调整',
}

const creditAdjustment = z
  .string()
  .trim()
  .regex(/^-?\d+$/, '请输入整数，正数补发、负数扣减')
  .refine((value) => Number(value) !== 0, '积分数量不能为 0')
  .refine(
    (value) => Math.abs(Number(value)) <= MAX_CREDIT_BALANCE,
    `单次调整不能超过 ${credits(MAX_CREDIT_BALANCE)} 积分`,
  )
const reasonField = z.string().trim().min(1, '请填写操作原因').max(500, '最多 500 个字符')
const localDateTimeField = z.string().min(1, '请选择日期和时间')

function paidCents(value: string): number | null {
  const normalized = value.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const [whole, fraction = ''] = normalized.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents > 0 && cents <= MAX_CREDIT_BALANCE ? cents : null
}

const paymentFields = {
  funding: z.enum(['paid', 'free']),
  paidAmount: z.string(),
}

function validatePayment(
  input: { funding: 'paid' | 'free'; paidAmount: string },
  context: z.RefinementCtx,
) {
  if (input.funding === 'paid' && paidCents(input.paidAmount) === null) {
    context.addIssue({
      code: 'custom',
      path: ['paidAmount'],
      message: '请输入实际收款金额，最多两位小数且必须大于 0',
    })
  }
}

const rechargeSchema = z
  .object({ amount: creditAdjustment, reason: reasonField, ...paymentFields })
  .superRefine((input, context) => {
    validatePayment(input, context)
    if (input.funding === 'paid' && Number(input.amount) <= 0) {
      context.addIssue({ code: 'custom', path: ['amount'], message: '付费充值的积分必须大于 0' })
    }
  })
type RechargeValues = z.infer<typeof rechargeSchema>

const subscriptionSchema = z
  .object({
    planId: z.string().min(1, '请选择套餐'),
    period: z.enum(['1', '3', '12']),
    startsAt: localDateTimeField,
    reason: reasonField,
    ...paymentFields,
  })
  .superRefine(validatePayment)
type SubscriptionValues = z.infer<typeof subscriptionSchema>

const expirySchema = z.object({ endsAt: localDateTimeField, reason: reasonField })
type ExpiryValues = z.infer<typeof expirySchema>

const subscriptionCreditsSchema = z.object({ amount: creditAdjustment, reason: reasonField })
type SubscriptionCreditsValues = z.infer<typeof subscriptionCreditsSchema>

type BillingAction =
  | { kind: 'recharge'; amount: number; reason: string; paidAmountCents: number | null }
  | { kind: 'subscription-credits'; amount: number; reason: string }
  | {
      kind: 'subscription'
      planId: string
      periodMonths: BillingPeriodMonths
      startsAt: number
      reason: string
      paidAmountCents: number | null
    }
  | { kind: 'expiry'; subscriptionId: string; endsAt: number; reason: string }

const positiveCredits = z.number().int().positive().max(MAX_CREDIT_BALANCE)
const pendingPaymentSchema = z.object({
  id: z.string().uuid(),
  input: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('recharge'),
      amount: positiveCredits,
      reason: reasonField,
      paidAmountCents: positiveCredits,
    }),
    z.object({
      kind: z.literal('subscription'),
      planId: z.string().min(1),
      periodMonths: z.union([z.literal(1), z.literal(3), z.literal(12)]),
      startsAt: z.number().int().safe(),
      reason: reasonField,
      paidAmountCents: positiveCredits,
    }),
  ]),
})
type PendingPayment = z.infer<typeof pendingPaymentSchema>

function readPendingPayment(key: string): PendingPayment | null {
  const saved = localStorage.getItem(key)
  if (saved === null) return null
  return pendingPaymentSchema.parse(JSON.parse(saved))
}

function isDefinitivePaymentRejection(error: unknown): boolean {
  if (!(error instanceof ApiError) || (error.status !== 400 && error.status !== 404)) return false
  const code =
    typeof error.body === 'object' && error.body !== null && 'error' in error.body
      ? error.body.error
      : undefined
  // These checks can reject a new payment, but committed replays bypass them.
  // Conflicts, authentication failures and unknown outcomes must retain the original identity.
  return (
    code === 'plan_not_found' ||
    code === 'plan_inactive' ||
    code === 'active_subscription_plan_mismatch' ||
    code === 'renewal_start_after_current_end' ||
    code === 'credit_balance_overflow'
  )
}

function PaymentFields({
  funding,
  amount,
  pending,
  error,
  onFundingChange,
  onAmountChange,
  onAmountBlur,
  amountRef,
}: {
  funding: 'paid' | 'free'
  amount: string
  pending: boolean
  error?: string
  onFundingChange: (value: 'paid' | 'free') => void
  onAmountChange: (value: string) => void
  onAmountBlur: () => void
  amountRef: Ref<HTMLInputElement>
}) {
  const id = useId()
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {funding === 'free' ? (
          <>
            <p className="text-sm font-medium">入账性质</p>
            <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              免费赠送 / 补偿 / 调整
            </p>
          </>
        ) : (
          <>
            <label htmlFor={`${id}-funding`} className="text-sm font-medium">
              入账性质
            </label>
            <Select value={funding} onValueChange={onFundingChange} disabled={pending}>
              <SelectTrigger id={`${id}-funding`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="free">免费赠送 / 补偿 / 调整</SelectItem>
              </SelectContent>
            </Select>
          </>
        )}
      </div>
      {funding === 'paid' ? (
        <div className="space-y-2">
          <label htmlFor={`${id}-amount`} className="text-sm font-medium">
            实际收款（元）
          </label>
          <Input
            id={`${id}-amount`}
            ref={amountRef}
            name="paidAmount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => onAmountChange(event.target.value)}
            onBlur={onAmountBlur}
            placeholder="例如 100.00"
            disabled={pending}
            aria-invalid={Boolean(error)}
          />
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">按实收金额记录付款；赠送与补偿不算付款。</p>
        </div>
      ) : null}
    </div>
  )
}

function ledgerLabel(entry: LedgerEntry): string {
  if (entry.reference_id === 'welcome-credit') return '开户赠送'
  return LEDGER_LABELS[entry.entry_type] ?? entry.entry_type
}

function RechargeForm({
  balance,
  pending,
  resetEpoch,
  onSubmit,
}: {
  balance: number
  pending: boolean
  resetEpoch: number
  onSubmit: (input: BillingAction) => void
}) {
  const form = useForm<RechargeValues>({
    resolver: zodResolver(rechargeSchema),
    defaultValues: { amount: '', reason: '', funding: 'free', paidAmount: '' },
  })
  useEffect(() => {
    if (resetEpoch > 0) form.reset({ amount: '', reason: '', funding: 'free', paidAmount: '' })
  }, [form, resetEpoch])
  const deducting = Number(useWatch({ control: form.control, name: 'amount' })) < 0
  const funding = useWatch({ control: form.control, name: 'funding' })
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-4">
        <CardTitle className="text-base">积分充值 / 调整</CardTitle>
        <CardDescription>仅用于免费补偿、赠送或扣减；实际收款请在订单核款中处理。</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            className="space-y-4"
            noValidate
            onSubmit={form.handleSubmit((input) => {
              onSubmit({
                kind: 'recharge',
                amount: Number(input.amount),
                reason: input.reason,
                paidAmountCents: input.funding === 'paid' ? paidCents(input.paidAmount) : null,
              })
            })}
          >
            <FormField
              control={form.control}
              name="paidAmount"
              render={({ field, fieldState }) => (
                <PaymentFields
                  funding={funding}
                  amount={field.value}
                  pending={pending}
                  error={fieldState.error?.message}
                  onFundingChange={(value) => form.setValue('funding', value)}
                  onAmountChange={field.onChange}
                  onAmountBlur={field.onBlur}
                  amountRef={field.ref}
                />
              )}
            />
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>积分数量</FormLabel>
                  <FormControl>
                    <Input type="number" step="1" placeholder="例如 500 或 -500" {...field} />
                  </FormControl>
                  <FormDescription>
                    当前可用 {credits(balance)} 积分，扣减不能超过可用余额。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>原因</FormLabel>
                  <FormControl>
                    <Input maxLength={500} placeholder="例如 补偿失败任务" {...field} />
                  </FormControl>
                  <FormDescription>操作原因会写入积分流水。</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              variant={deducting ? 'destructive' : 'default'}
              className="w-full"
              disabled={pending}
            >
              {deducting ? '确认扣减' : '确认入账'}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}

function SubscriptionCreditsForm({
  balance,
  expiresAt,
  pending,
  resetEpoch,
  onSubmit,
}: {
  balance: number
  expiresAt: number | null
  pending: boolean
  resetEpoch: number
  onSubmit: (input: BillingAction) => void
}) {
  const form = useForm<SubscriptionCreditsValues>({
    resolver: zodResolver(subscriptionCreditsSchema),
    defaultValues: { amount: '', reason: '' },
  })
  useEffect(() => {
    if (resetEpoch > 0) form.reset({ amount: '', reason: '' })
  }, [form, resetEpoch])
  const deducting = Number(useWatch({ control: form.control, name: 'amount' })) < 0
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-4">
        <CardTitle className="text-base">套餐积分补发 / 扣减</CardTitle>
        <CardDescription>
          补到套餐积分，沿用套餐积分的到期时间；到期或下次月度发放时清零重发。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            className="space-y-4"
            noValidate
            onSubmit={form.handleSubmit((input) => {
              onSubmit({
                kind: 'subscription-credits',
                amount: Number(input.amount),
                reason: input.reason,
              })
            })}
          >
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>积分数量</FormLabel>
                  <FormControl>
                    <Input type="number" step="1" placeholder="例如 500 或 -500" {...field} />
                  </FormControl>
                  <FormDescription>
                    当前套餐积分 {credits(balance)}
                    {expiresAt === null ? '' : `，到期 ${dateTime(expiresAt)}`}。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>原因</FormLabel>
                  <FormControl>
                    <Input maxLength={500} placeholder="例如 续费后未发放额度" {...field} />
                  </FormControl>
                  <FormDescription>操作原因会写入积分流水。</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              variant={deducting ? 'destructive' : 'default'}
              className="w-full"
              disabled={pending}
            >
              {deducting ? '确认扣减' : '确认补发'}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}

function SubscriptionForm({
  plans,
  currentPlanId,
  pending,
  resetEpoch,
  onEdit,
  onSubmit,
}: {
  plans: Plan[]
  currentPlanId: string | null
  pending: boolean
  resetEpoch: number
  onEdit: () => void
  onSubmit: (input: BillingAction) => void
}) {
  const defaultPlanId = plans.find((plan) => plan.id === currentPlanId)?.id ?? plans[0]?.id ?? ''
  const form = useForm<SubscriptionValues>({
    resolver: zodResolver(subscriptionSchema),
    defaultValues: {
      planId: defaultPlanId,
      period: '1',
      startsAt: toLocalInput(Date.now()),
      reason: '',
      funding: 'free',
      paidAmount: '',
    },
  })
  const lastResetRef = useRef(0)
  useEffect(() => {
    if (resetEpoch > 0 && resetEpoch !== lastResetRef.current) {
      lastResetRef.current = resetEpoch
      form.reset({
        planId: defaultPlanId,
        period: '1',
        startsAt: toLocalInput(Date.now()),
        reason: '',
        funding: 'free',
        paidAmount: '',
      })
    }
  }, [defaultPlanId, form, resetEpoch])
  useEffect(() => {
    if (form.getValues('planId') === '' && defaultPlanId !== '')
      form.setValue('planId', defaultPlanId)
  }, [defaultPlanId, form])
  const planId = useWatch({ control: form.control, name: 'planId' })
  const period = useWatch({ control: form.control, name: 'period' })
  const selectedPlan = plans.find((plan) => plan.id === planId) ?? null
  const selectedPeriod = Number(period) as BillingPeriodMonths
  const selectedPrice =
    selectedPlan?.prices.find((price) => price.period_months === selectedPeriod) ?? null
  const funding = useWatch({ control: form.control, name: 'funding' })
  const priceSelection = useRef('')
  const priceKey = `${planId}:${period}`
  const defaultPrice = selectedPrice?.effective_price_cents
  useEffect(() => {
    if (priceSelection.current !== priceKey || !form.getFieldState('paidAmount').isDirty) {
      form.resetField('paidAmount', {
        defaultValue: defaultPrice === undefined ? '' : (defaultPrice / 100).toFixed(2),
      })
      priceSelection.current = priceKey
    }
  }, [defaultPrice, form, priceKey])

  return (
    <Card className="min-w-0">
      <CardHeader className="pb-4">
        <CardTitle className="text-base">开通 / 续期套餐</CardTitle>
        <CardDescription>仅用于免费赠送套餐；实际收款请在订单核款中处理。</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            className="space-y-4"
            noValidate
            onSubmit={form.handleSubmit((input) => {
              onSubmit({
                kind: 'subscription',
                planId: input.planId,
                periodMonths: Number(input.period) as BillingPeriodMonths,
                startsAt: parseLocalInput(input.startsAt),
                reason: input.reason,
                paidAmountCents: input.funding === 'paid' ? paidCents(input.paidAmount) : null,
              })
            })}
          >
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="planId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>套餐</FormLabel>
                    <Select
                      onValueChange={(value) => {
                        onEdit()
                        field.onChange(value)
                      }}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="选择套餐" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {plans.map((plan) => (
                          <SelectItem key={plan.id} value={plan.id}>
                            {plan.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="period"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>周期</FormLabel>
                    <Select
                      onValueChange={(value) => {
                        onEdit()
                        field.onChange(value)
                      }}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="1">1 个月</SelectItem>
                        <SelectItem value="3">3 个月</SelectItem>
                        <SelectItem value="12">12 个月</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {selectedPrice ? (
              <div className="rounded-md bg-muted/60 px-3 py-2 text-xs">
                应收 <strong>{money(selectedPrice.effective_price_cents)}</strong>
                {selectedPrice.effective_price_cents !== selectedPrice.original_price_cents ? (
                  <del className="ml-2 text-muted-foreground">
                    原价 {money(selectedPrice.original_price_cents)}
                  </del>
                ) : null}
                <span className="ml-2 text-muted-foreground">
                  {selectedPlan?.name} · {selectedPeriod} 个月
                </span>
              </div>
            ) : null}
            <FormField
              control={form.control}
              name="paidAmount"
              render={({ field, fieldState }) => (
                <PaymentFields
                  funding={funding}
                  amount={field.value}
                  pending={pending}
                  error={fieldState.error?.message}
                  onFundingChange={(value) => form.setValue('funding', value)}
                  onAmountChange={field.onChange}
                  onAmountBlur={field.onBlur}
                  amountRef={field.ref}
                />
              )}
            />
            <FormField
              control={form.control}
              name="startsAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>起始时间</FormLabel>
                  <FormControl>
                    <Input type="datetime-local" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>原因</FormLabel>
                  <FormControl>
                    <Input maxLength={500} placeholder="例如 活动赠送" {...field} />
                  </FormControl>
                  <FormDescription>操作原因会写入订阅审计记录。</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" className="w-full" disabled={pending || plans.length === 0}>
              确认套餐
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}

function ExpiryForm({
  subscription,
  pending,
  resetEpoch,
  onSubmit,
}: {
  subscription: AccountSnapshot['subscription']
  pending: boolean
  resetEpoch: number
  onSubmit: (input: BillingAction) => void
}) {
  const form = useForm<ExpiryValues>({
    resolver: zodResolver(expirySchema),
    defaultValues: { endsAt: subscription ? toLocalInput(subscription.ends_at) : '', reason: '' },
  })
  useEffect(() => {
    form.setValue('endsAt', subscription ? toLocalInput(subscription.ends_at) : '')
  }, [form, subscription?.id, subscription?.ends_at])
  const lastResetRef = useRef(0)
  useEffect(() => {
    if (resetEpoch > 0 && resetEpoch !== lastResetRef.current) {
      lastResetRef.current = resetEpoch
      form.reset({ endsAt: subscription ? toLocalInput(subscription.ends_at) : '', reason: '' })
    }
  }, [form, resetEpoch, subscription])
  return (
    <Card className="min-w-0">
      <CardHeader className="pb-4">
        <CardTitle className="text-base">调整套餐截止</CardTitle>
        <CardDescription>延长或缩短当前套餐有效期。</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            className="space-y-4"
            noValidate
            onSubmit={form.handleSubmit((input) => {
              if (!subscription) return
              onSubmit({
                kind: 'expiry',
                subscriptionId: subscription.id,
                endsAt: parseLocalInput(input.endsAt),
                reason: input.reason,
              })
            })}
          >
            <FormField
              control={form.control}
              name="endsAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>新截止时间</FormLabel>
                  <FormControl>
                    <Input type="datetime-local" disabled={!subscription} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>原因</FormLabel>
                  <FormControl>
                    <Input
                      maxLength={500}
                      disabled={!subscription}
                      placeholder="例如 人工续期"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>没有有效套餐时不能调整截止时间。</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              variant="outline"
              className="w-full"
              disabled={pending || !subscription}
            >
              保存有效期
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}

function BillingActionConfirmDialog({
  action,
  username,
  plans,
  pending,
  error,
  onOpenChange,
  onConfirm,
}: {
  action: BillingAction | null
  username: string
  plans: Plan[]
  pending: boolean
  error: unknown
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const summary = action ? describeBillingAction(action, plans) : null
  return (
    <Dialog open={action !== null} onOpenChange={onOpenChange}>
      <DialogContent
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (pending) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{summary?.title ?? '确认账务操作'}</DialogTitle>
          <DialogDescription>
            操作将立即生效并写入审计日志，请核对以下信息后确认执行。
          </DialogDescription>
        </DialogHeader>
        {summary && action ? (
          <dl className="space-y-2 rounded-lg border bg-muted/30 p-3 text-xs">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">目标用户</dt>
              <dd className="font-medium text-foreground">{username}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">变更内容</dt>
              <dd className="font-mono font-medium text-foreground">{summary.detail}</dd>
            </div>
            {summary.extra ? (
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">补充信息</dt>
                <dd className="text-foreground">{summary.extra}</dd>
              </div>
            ) : null}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">操作原因</dt>
              <dd className="max-w-[260px] break-words text-right text-foreground">
                {action.reason}
              </dd>
            </div>
          </dl>
        ) : null}
        <ErrorText error={error} />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            variant={summary?.destructive ? 'destructive' : 'default'}
            disabled={pending || !action}
            aria-busy={pending}
            onClick={onConfirm}
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
            {pending ? '提交中…' : (summary?.confirmLabel ?? '确认执行')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function describeBillingAction(
  action: BillingAction,
  plans: Plan[],
): { title: string; detail: string; extra?: string; confirmLabel: string; destructive: boolean } {
  if (action.kind === 'recharge') {
    const deduct = action.amount < 0
    return {
      title: deduct ? '确认扣减充值积分' : '确认补发 / 入账充值积分',
      detail: `${action.amount > 0 ? '+' : ''}${credits(action.amount)} 积分`,
      extra:
        action.paidAmountCents !== null
          ? `记录实收 ${money(action.paidAmountCents)}`
          : '免费补偿 / 调整（不计入实付）',
      confirmLabel: deduct ? '确认扣减' : '确认入账',
      destructive: deduct,
    }
  }
  if (action.kind === 'subscription-credits') {
    const deduct = action.amount < 0
    return {
      title: deduct ? '确认扣减套餐积分' : '确认补发套餐积分',
      detail: `${action.amount > 0 ? '+' : ''}${credits(action.amount)} 套餐积分`,
      confirmLabel: deduct ? '确认扣减' : '确认补发',
      destructive: deduct,
    }
  }
  if (action.kind === 'subscription') {
    const planName = plans.find((plan) => plan.id === action.planId)?.name ?? action.planId
    return {
      title: '确认开通 / 续期套餐',
      detail: `${planName} · ${action.periodMonths} 个月`,
      extra: `${dateTime(action.startsAt)} 起 · ${
        action.paidAmountCents !== null
          ? `实收 ${money(action.paidAmountCents)}`
          : '免费赠送（不计入实付）'
      }`,
      confirmLabel: '确认开通',
      destructive: false,
    }
  }
  return {
    title: '确认调整套餐截止时间',
    detail: `新截止时间：${dateTime(action.endsAt)}`,
    confirmLabel: '确认修改',
    destructive: false,
  }
}

function UserDetailPanel({
  userId,
  username,
  children,
  profile,
}: {
  userId: string
  username: string
  children?: ReactNode
  profile?: ReactNode
}) {
  const [tab, setTab] = useState('tasks')
  const [billingTarget, setBillingTarget] = useState<'credits' | 'subscription' | null>(null)
  const [confirmAction, setConfirmAction] = useState<BillingAction | null>(null)
  const [resetEpochs, setResetEpochs] = useState<Record<BillingAction['kind'], number>>({
    recharge: 0,
    'subscription-credits': 0,
    subscription: 0,
    expiry: 0,
  })
  const creditForm = useRef<HTMLDivElement>(null)
  const subscriptionForm = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (tab !== 'ops' || !billingTarget) return
    const target = billingTarget === 'credits' ? creditForm.current : subscriptionForm.current
    target?.focus()
    setBillingTarget(null)
  }, [billingTarget, tab])
  const queryClient = useQueryClient()
  const paymentStorageKey = `billing.pending-payment:${userId}`
  const [paymentRecovery, setPaymentRecovery] = useState<{
    key: string
    payment: PendingPayment | null
    error: unknown
  } | null>(null)
  const pendingPayment = paymentRecovery?.key === paymentStorageKey ? paymentRecovery.payment : null
  useEffect(() => {
    try {
      setPaymentRecovery({
        key: paymentStorageKey,
        payment: readPendingPayment(paymentStorageKey),
        error: null,
      })
    } catch (error) {
      setPaymentRecovery({ key: paymentStorageKey, payment: null, error })
    }
  }, [paymentStorageKey])
  const accountQuery = useQuery({
    queryKey: ['private-billing', 'account', userId],
    queryFn: () =>
      apiClient.get<OperatorAccountSnapshot>(
        `/api/private/billing/users/${encodeURIComponent(userId)}`,
      ),
  })
  const catalogQuery = useQuery({
    queryKey: ['private-billing', 'catalog'],
    queryFn: () => apiClient.get<Catalog>('/api/private/billing/catalog'),
  })
  const chatUsageQuery = useChatUsage(
    `/api/private/billing/users/${encodeURIComponent(userId)}/chat-usage`,
  )
  const [ledgerRows, setLedgerRows] = useState<LedgerEntry[]>([])
  const [nextLedgerOffset, setNextLedgerOffset] = useState<number | null>(null)
  const ledgerView = visibleLedger(ledgerRows)
  useEffect(() => {
    if (!accountQuery.data) return
    setLedgerRows(accountQuery.data.ledger)
    setNextLedgerOffset(accountQuery.data.ledger.length === 100 ? 100 : null)
  }, [accountQuery.data])
  const loadMoreLedger = useMutation({
    mutationFn: (offset: number) =>
      apiClient.get<LedgerPage>(
        `/api/private/billing/users/${encodeURIComponent(userId)}/ledger?offset=${offset}&limit=100`,
      ),
    onSuccess: (page) => {
      setLedgerRows((current) => [...current, ...page.ledger])
      setNextLedgerOffset(page.next_offset)
    },
  })
  const mutation = useMutation({
    mutationFn: async ({ input, paymentId }: { input: BillingAction; paymentId?: string }) => {
      let payment: { operation_id: string; amount_cents: number } | null = null
      if (
        (input.kind === 'recharge' || input.kind === 'subscription') &&
        input.paidAmountCents !== null
      ) {
        const saved = readPendingPayment(paymentStorageKey)
        if (!paymentId && saved && JSON.stringify(saved.input) !== JSON.stringify(input)) {
          setPaymentRecovery({ key: paymentStorageKey, payment: saved, error: null })
          throw new Error('有一笔实付确认结果待核对，请先重试原付款，不要重复新增付款。')
        }
        const attempt = { id: paymentId ?? saved?.id ?? crypto.randomUUID(), input }
        // Save before sending: reloads and lost responses must retain the original payment identity.
        // Retrying an older operation must not replace another pending payment.
        if (!saved || saved.id === attempt.id) {
          localStorage.setItem(paymentStorageKey, JSON.stringify(attempt))
          setPaymentRecovery({
            key: paymentStorageKey,
            payment: pendingPaymentSchema.parse(attempt),
            error: null,
          })
        }
        payment = { operation_id: attempt.id, amount_cents: input.paidAmountCents }
      }
      try {
        if (input.kind === 'recharge') {
          await apiClient.post(
            `/api/private/billing/users/${encodeURIComponent(userId)}/recharge`,
            {
              amount: input.amount,
              reason: input.reason,
              payment,
            },
          )
        } else if (input.kind === 'subscription') {
          await apiClient.post(
            `/api/private/billing/users/${encodeURIComponent(userId)}/subscriptions`,
            {
              plan_id: input.planId,
              period_months: input.periodMonths,
              starts_at: input.startsAt,
              reason: input.reason,
              payment,
            },
          )
        } else if (input.kind === 'subscription-credits') {
          await apiClient.post(
            `/api/private/billing/users/${encodeURIComponent(userId)}/subscription-credits`,
            { amount: input.amount, reason: input.reason },
          )
        } else {
          await apiClient.post(
            `/api/private/billing/subscriptions/${encodeURIComponent(input.subscriptionId)}/expiry`,
            { ends_at: input.endsAt, reason: input.reason },
          )
        }
      } catch (error) {
        if (
          payment &&
          isDefinitivePaymentRejection(error) &&
          readPendingPayment(paymentStorageKey)?.id === payment.operation_id
        ) {
          localStorage.removeItem(paymentStorageKey)
          setPaymentRecovery({ key: paymentStorageKey, payment: null, error: null })
        }
        throw error
      }
      return payment?.operation_id ?? null
    },
    onSuccess: async (paymentId, variables) => {
      setConfirmAction(null)
      setResetEpochs((prev) => ({
        ...prev,
        [variables.input.kind]: prev[variables.input.kind] + 1,
      }))
      if (paymentId && readPendingPayment(paymentStorageKey)?.id === paymentId) {
        localStorage.removeItem(paymentStorageKey)
        setPaymentRecovery({ key: paymentStorageKey, payment: null, error: null })
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['users'] }),
        queryClient.invalidateQueries({ queryKey: ['private-billing', 'account', userId] }),
        queryClient.invalidateQueries({ queryKey: ['private-billing', 'user-summaries'] }),
        queryClient.invalidateQueries({ queryKey: ['private-billing', 'overview'] }),
      ])
    },
  })
  const resetMutation = () => {
    if (!mutation.isPending) mutation.reset()
  }

  const data = accountQuery.data
  const plans = (catalogQuery.data?.plans ?? []).filter((plan) => plan.active)
  function openBilling(target: 'credits' | 'subscription') {
    setBillingTarget(target)
    setTab('ops')
  }
  const tabClass =
    'h-9 rounded-none border-b-2 border-transparent data-[state=active]:border-brand-hover data-[state=active]:bg-transparent data-[state=active]:shadow-none'
  const paneClass = 'mt-4 data-[state=inactive]:hidden'

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[248px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)]">
      <div className="min-w-0 space-y-4">
        <Section title="积分与套餐">
          {accountQuery.isPending ? (
            <p className="text-sm text-muted-foreground">正在读取 {username} 的积分账户…</p>
          ) : accountQuery.isError || !data ? (
            <div className="flex items-center justify-between gap-2 text-sm text-destructive">
              <span>积分账户读取失败</span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={accountQuery.isFetching}
                onClick={() => void accountQuery.refetch()}
              >
                <RefreshCw
                  className={accountQuery.isFetching ? 'size-3 animate-spin' : 'size-3'}
                  aria-hidden="true"
                />
                重试
              </Button>
            </div>
          ) : (
            <AccountFacts data={data} plans={catalogQuery.data?.plans ?? []} />
          )}
          {data?.account ? (
            <div className="mt-3 flex flex-col items-stretch gap-2">
              <Button variant="brand" onClick={() => openBilling('credits')}>
                调整积分
              </Button>
              <Button variant="outline" onClick={() => openBilling('subscription')}>
                续期 / 改有效期
              </Button>
            </div>
          ) : null}
        </Section>
        {profile}
        <Section title="对话消耗">
          {chatUsageQuery.isPending ? (
            <p className="text-sm text-muted-foreground">正在读取对话消耗…</p>
          ) : chatUsageQuery.isError || !chatUsageQuery.data ? (
            <div className="flex items-center justify-between gap-2 text-sm text-destructive">
              <span>对话消耗读取失败</span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={chatUsageQuery.isFetching}
                onClick={() => void chatUsageQuery.refetch()}
              >
                <RefreshCw
                  className={chatUsageQuery.isFetching ? 'size-3 animate-spin' : 'size-3'}
                  aria-hidden="true"
                />
                重试
              </Button>
            </div>
          ) : (
            <ChatUsageFacts usage={chatUsageQuery.data} />
          )}
        </Section>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="order-first min-w-0 lg:order-none">
        <TabsList
          aria-label="用户档案分区"
          className="h-auto max-w-full justify-start overflow-x-auto rounded-none border-b bg-transparent p-0"
        >
          <TabsTrigger className={tabClass} value="tasks">
            最近任务
          </TabsTrigger>
          <TabsTrigger className={tabClass} value="ops">
            账务操作
          </TabsTrigger>
          <TabsTrigger className={tabClass} value="ledger">
            积分流水
          </TabsTrigger>
          <TabsTrigger className={tabClass} value="payments">
            实付记录
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tasks" forceMount className={paneClass}>
          {children}
        </TabsContent>

        <TabsContent value="ops" forceMount className={paneClass}>
          {!data ? (
            <p className="text-sm text-muted-foreground">
              {accountQuery.isError ? '无法加载运营操作' : '正在读取账户…'}
            </p>
          ) : !data.account ? (
            <p className="text-sm text-muted-foreground">
              该用户为未计费账号，没有积分账户或账务操作。
            </p>
          ) : (
            <>
              {pendingPayment ? (
                <div
                  role="status"
                  className="mb-4 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
                >
                  <p>
                    待确认原付款：
                    {pendingPayment.input.kind === 'recharge' ? '积分充值' : '套餐开通 / 续期'}
                    {' · '}
                    {money(pendingPayment.input.paidAmountCents)}
                  </p>
                  <p className="break-words text-xs text-muted-foreground">
                    {pendingPayment.input.reason}
                    。刷新页面或响应丢失后，请重试原付款；不会重复入账。
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={mutation.isPending}
                    onClick={() =>
                      mutation.mutate({
                        input: pendingPayment.input,
                        paymentId: pendingPayment.id,
                      })
                    }
                  >
                    重试确认原付款
                  </Button>
                </div>
              ) : null}
              <ErrorText
                error={paymentRecovery?.key === paymentStorageKey ? paymentRecovery.error : null}
              />
              {mutation.isSuccess ? (
                <p
                  role="status"
                  className="mb-4 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"
                >
                  操作成功，已记录。
                </p>
              ) : null}
              <div
                className="grid grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] gap-4"
                onChange={resetMutation}
              >
                <div
                  ref={creditForm}
                  tabIndex={-1}
                  className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <RechargeForm
                    balance={data.account.recharge_balance}
                    pending={mutation.isPending}
                    resetEpoch={resetEpochs.recharge}
                    onSubmit={(input) => {
                      resetMutation()
                      setConfirmAction(input)
                    }}
                  />
                </div>
                <SubscriptionCreditsForm
                  balance={data.account.subscription_balance}
                  expiresAt={data.account.subscription_expires_at}
                  pending={mutation.isPending}
                  resetEpoch={resetEpochs['subscription-credits']}
                  onSubmit={(input) => {
                    resetMutation()
                    setConfirmAction(input)
                  }}
                />
                <div
                  ref={subscriptionForm}
                  tabIndex={-1}
                  className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <SubscriptionForm
                    plans={plans}
                    currentPlanId={data.subscription?.plan_id ?? null}
                    pending={mutation.isPending}
                    resetEpoch={resetEpochs.subscription}
                    onEdit={resetMutation}
                    onSubmit={(input) => {
                      resetMutation()
                      setConfirmAction(input)
                    }}
                  />
                </div>
                <ExpiryForm
                  subscription={data.subscription}
                  pending={mutation.isPending}
                  resetEpoch={resetEpochs.expiry}
                  onSubmit={(input) => {
                    resetMutation()
                    setConfirmAction(input)
                  }}
                />
              </div>
              <BillingActionConfirmDialog
                action={confirmAction}
                username={username}
                plans={plans}
                pending={mutation.isPending}
                error={confirmAction ? mutation.error : null}
                onOpenChange={(open) => {
                  if (!open && !mutation.isPending) {
                    setConfirmAction(null)
                    resetMutation()
                  }
                }}
                onConfirm={() => {
                  if (!confirmAction) return
                  mutation.mutate({ input: confirmAction })
                }}
              />
              <div className="mt-3 min-h-5" aria-live="polite">
                {mutation.isPending ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    正在提交操作
                  </span>
                ) : null}
                <ErrorText error={mutation.error} />
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="payments" forceMount className={paneClass}>
          <a
            className="mb-4 inline-block text-sm underline"
            href={`/billing/orders?user=${encodeURIComponent(userId)}`}
          >
            查看此用户订单与核款
          </a>
          <Section
            title="实付记录"
            description="最近 100 笔确认收款；免费赠送、补偿和按月发放不在此列。"
          >
            {!data ? (
              <p className="text-sm text-muted-foreground">正在读取收款记录…</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      <th className="px-3 py-2">时间</th>
                      <th className="px-3 py-2">用途</th>
                      <th className="px-3 py-2">付款记录</th>
                      <th className="px-3 py-2 text-right">实收金额</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.payments.map((payment) => (
                      <tr key={payment.id}>
                        <td className="whitespace-nowrap px-3 py-2">
                          {dateTime(payment.created_at)}
                        </td>
                        <td className="px-3 py-2">
                          {payment.kind === 'recharge' ? '积分充值' : '套餐购买 / 续费'}
                        </td>
                        <td className="px-3 py-2 font-mono">{payment.id}</td>
                        <td className="px-3 py-2 text-right">{money(payment.amount_cents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.payments.length === 0 ? (
                  <p className="py-6 text-center text-muted-foreground">暂无实付记录</p>
                ) : null}
              </div>
            )}
          </Section>
        </TabsContent>

        <TabsContent value="ledger" forceMount className={paneClass}>
          <p className="mb-3 text-xs text-muted-foreground">
            已加载 {ledgerRows.length} 条
            {ledgerView.hidden > 0 ? `，其中 ${ledgerView.hidden} 条零变动的记录未显示` : ''}
          </p>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="bg-muted/50 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">时间</th>
                  <th className="px-3 py-2">类型</th>
                  <th className="px-3 py-2">账户</th>
                  <th className="px-3 py-2">模型 / 任务</th>
                  <th className="px-3 py-2">备注</th>
                  <th className="px-3 py-2 text-right">变动</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {ledgerView.shown.map((entry) => (
                  <tr key={entry.id}>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {dateTime(entry.created_at)}
                    </td>
                    <td className="px-3 py-2">{ledgerLabel(entry)}</td>
                    <td className="px-3 py-2">
                      {entry.bucket === 'subscription' ? '套餐' : '充值'}
                    </td>
                    <td className="max-w-[200px] truncate px-3 py-2 font-mono text-[10px]">
                      {entry.model ?? entry.task_id ?? '—'}
                    </td>
                    <td className="max-w-[220px] truncate px-3 py-2 text-muted-foreground">
                      {entry.note ?? '—'}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-mono ${entry.amount >= 0 ? 'text-emerald-600' : 'text-destructive'}`}
                    >
                      {entry.amount >= 0 ? '+' : ''}
                      {credits(entry.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ledgerView.shown.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground">暂无流水</p>
            ) : null}
          </div>
          {nextLedgerOffset !== null ? (
            <Button
              type="button"
              variant="outline"
              className="mt-3 w-full"
              disabled={loadMoreLedger.isPending}
              onClick={() => loadMoreLedger.mutate(nextLedgerOffset)}
            >
              {loadMoreLedger.isPending ? '读取中…' : '加载更早流水'}
            </Button>
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  )
}

export { UserDetailPanel }
