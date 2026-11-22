import { zodResolver } from '@hookform/resolvers/zod'
import type { Catalog, Plan, ReferralPolicy } from '@image-playground/shared'
import { MAX_CREDIT_BALANCE } from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { apiClient } from '../../lib/private-host'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
  Switch,
  Textarea,
} from '../../lib/private-host-ui'
import { parseLocalInput, toLocalInput } from './shared'

const requiredInteger = z.string().trim().regex(/^\d+$/, '请输入整数')
const positiveInteger = requiredInteger.refine((value) => Number(value) > 0, '必须大于 0')
const optionalInteger = z
  .string()
  .trim()
  .refine((value) => value === '' || /^\d+$/.test(value), '请输入整数')

const settingsSchema = z.object({
  paymentsEnabled: z.boolean(),
  paymentChannel: z.enum(['wechat', 'alipay']),
  receivingAccount: z.string().trim().max(200),
  contactWechat: z.string().trim().max(200, '最多 200 个字符'),
  paymentQrUrl: z.string().trim().max(2000, '最多 2000 个字符'),
  contactQrUrl: z.string().trim().max(2000, '最多 2000 个字符'),
  guidance: z.string().trim().max(2000, '最多 2000 个字符'),
})
type SettingsValues = z.infer<typeof settingsSchema>

const planSchema = z.object({
  name: z.string().trim().min(1, '请输入套餐名称').max(100, '最多 100 个字符'),
  monthlyCredits: positiveInteger,
  maxConcurrentTasks: positiveInteger.refine((value) => Number(value) <= 100, '最多 100'),
  active: z.boolean(),
  prices: z.array(
    z
      .object({
        periodMonths: z.number(),
        original: requiredInteger,
        discount: optionalInteger,
        discountEnds: z.string(),
      })
      .superRefine((price, context) => {
        if (price.discount !== '' && price.discountEnds === '') {
          context.addIssue({
            code: 'custom',
            message: '请选择优惠截止时间',
            path: ['discountEnds'],
          })
        }
      }),
  ),
})
type PlanValues = z.infer<typeof planSchema>

const referralCreditAmount = requiredInteger.refine(
  (value) => Number(value) <= MAX_CREDIT_BALANCE,
  '积分数量超出上限',
)
const referralSchema = z.object({
  inviterCredits: referralCreditAmount,
  inviteeCredits: referralCreditAmount,
  percent: z
    .string()
    .trim()
    .regex(/^\d+(?:\.\d{1,2})?$/, '最多保留两位小数')
    .refine((value) => Number(value) <= 100, '比例必须在 0–100% 之间'),
  creditsPerYuan: z
    .string()
    .trim()
    .regex(/^\d+(?:\.\d{1,4})?$/, '最多保留四位小数')
    .refine(
      (value) => Number(value) > 0 && Number(value) <= MAX_CREDIT_BALANCE,
      '折算率必须大于 0 且不超出上限',
    ),
})
type ReferralValues = z.infer<typeof referralSchema>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '保存失败，请重试'
}

export function SaveStatus({
  pending,
  success,
  error,
}: {
  pending: boolean
  success: boolean
  error: unknown
}) {
  if (pending) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        role="status"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        正在保存
      </span>
    )
  }
  if (error)
    return (
      <span className="text-xs text-destructive" role="alert">
        {errorMessage(error)}
      </span>
    )
  if (success) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600" role="status">
        <CheckCircle2 className="h-3.5 w-3.5" />
        已保存
      </span>
    )
  }
  return null
}

function SettingsEditor({ catalog }: { catalog: Catalog }) {
  const queryClient = useQueryClient()
  const values: SettingsValues = {
    paymentsEnabled: catalog.settings?.payments_enabled ?? false,
    paymentChannel: catalog.settings?.payment_channel ?? 'wechat',
    receivingAccount: catalog.settings?.receiving_account ?? '',
    contactWechat: catalog.settings?.contact_wechat ?? '',
    paymentQrUrl: catalog.settings?.payment_qr_url ?? '',
    contactQrUrl: catalog.settings?.contact_qr_url ?? '',
    guidance: catalog.settings?.guidance ?? '',
  }
  const form = useForm<SettingsValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: values,
  })
  useEffect(() => form.reset(values), [catalog.settings, form])
  const mutation = useMutation({
    mutationFn: (input: SettingsValues) =>
      apiClient.put('/api/private/billing/settings', {
        payments_enabled: input.paymentsEnabled,
        payment_channel: input.paymentChannel,
        receiving_account: input.receivingAccount,
        contact_wechat: input.contactWechat,
        payment_qr_url: input.paymentQrUrl,
        contact_qr_url: input.contactQrUrl,
        guidance: input.guidance,
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['private-billing', 'catalog'] }),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>收款与联系</CardTitle>
        <CardDescription>
          套餐续费收款设置。换码请使用新的图片 URL，以保留历史二维码。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            className="grid gap-5 lg:grid-cols-2"
            noValidate
            onChange={() => mutation.reset()}
            onSubmit={form.handleSubmit((input) => mutation.mutate(input))}
          >
            <FormField
              control={form.control}
              name="paymentsEnabled"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>开放自助续费付款</FormLabel>
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <FormDescription>收款码失效时先关闭，更新并核验新码后再开启。</FormDescription>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="paymentChannel"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>收款渠道</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="wechat">微信</SelectItem>
                      <SelectItem value="alipay">支付宝</SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="receivingAccount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>固定收款账户标识</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="与收款工具中账户对应的固定名称" />
                  </FormControl>
                  <FormDescription>同一账户更换二维码时保持不变；用于交易去重。</FormDescription>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="contactWechat"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>联系微信</FormLabel>
                  <FormControl>
                    <Input placeholder="微信号" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="paymentQrUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>收款码 URL</FormLabel>
                  <FormControl>
                    <Input placeholder="/op/payment-qr.png" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="contactQrUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>客服微信二维码 URL</FormLabel>
                  <FormControl>
                    <Input placeholder="/op/contact-qr.png" {...field} />
                  </FormControl>
                  <FormDescription>
                    同源相对路径或完整 URL。留空时充值界面显示联系微信号。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="guidance"
              render={({ field }) => (
                <FormItem className="lg:col-span-2">
                  <FormLabel>付款说明</FormLabel>
                  <FormControl>
                    <Textarea rows={4} placeholder="付款后请提供用户名" {...field} />
                  </FormControl>
                  <FormDescription>
                    最多 2000 个字符。修改后会立即影响用户充值界面。
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex items-center gap-3 lg:col-span-2">
              <Button type="submit" disabled={mutation.isPending}>
                保存付款配置
              </Button>
              <SaveStatus
                pending={mutation.isPending}
                success={mutation.isSuccess}
                error={mutation.error}
              />
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}

function ReferralPolicyEditor({ policy }: { policy: ReferralPolicy }) {
  const queryClient = useQueryClient()
  const values: ReferralValues = {
    inviterCredits: String(policy.inviter_registration_credits),
    inviteeCredits: String(policy.invitee_registration_credits),
    percent: String(policy.paid_reward_basis_points / 100),
    creditsPerYuan: String(policy.credits_per_yuan),
  }
  const form = useForm<ReferralValues>({
    resolver: zodResolver(referralSchema),
    defaultValues: values,
  })
  useEffect(() => form.reset(values), [policy, form])
  const mutation = useMutation({
    mutationFn: (input: ReferralValues) =>
      apiClient.put<ReferralPolicy>('/api/private/billing/referrals/policy', {
        inviter_registration_credits: Number(input.inviterCredits),
        invitee_registration_credits: Number(input.inviteeCredits),
        paid_reward_basis_points: Math.round(Number(input.percent) * 100),
        credits_per_yuan: Number(input.creditsPerYuan),
      }),
    onSuccess: (next) => queryClient.setQueryData(['private-billing', 'referral-policy'], next),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle>邀请奖励</CardTitle>
        <CardDescription>
          全站统一配置，只影响之后的注册与实际收款，不重算历史奖励。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((input) => mutation.mutate(input))}
            onChange={() => mutation.reset()}
            noValidate
          >
            <fieldset disabled={mutation.isPending} className="grid gap-5 lg:grid-cols-2">
              {(
                [
                  {
                    name: 'inviterCredits',
                    label: '邀请人注册奖励（积分）',
                    description: '自动进入消费积分。设为 0 仅关闭邀请人奖励。',
                    step: '1',
                    min: '0',
                    max: MAX_CREDIT_BALANCE,
                  },
                  {
                    name: 'inviteeCredits',
                    label: '受邀人注册奖励（积分）',
                    description: '与开户赠送独立，自动到账。设为 0 仅关闭受邀人奖励。',
                    step: '1',
                    min: '0',
                    max: MAX_CREDIT_BALANCE,
                  },
                  {
                    name: 'percent',
                    label: '充值返利比例（%）',
                    description: '按实际收款计算，含会员开通和续费。设为 0 关闭新返利。',
                    step: '0.01',
                    min: '0',
                    max: 100,
                  },
                  {
                    name: 'creditsPerYuan',
                    label: '折算率（积分 / 元）',
                    description: '独立于套餐权益。每笔返利向下取整为整数积分。',
                    step: '0.0001',
                    min: '0.0001',
                    max: MAX_CREDIT_BALANCE,
                  },
                ] as const
              ).map(({ name, label, description, ...limits }) => (
                <FormField
                  key={name}
                  control={form.control}
                  name={name}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{label}</FormLabel>
                      <FormControl>
                        <Input type="number" {...limits} {...field} />
                      </FormControl>
                      <FormDescription>{description}</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ))}
              <div className="flex items-center gap-3 lg:col-span-2">
                <Button type="submit" disabled={mutation.isPending}>
                  {mutation.isPending ? '正在保存…' : '保存邀请奖励配置'}
                </Button>
                <SaveStatus
                  pending={mutation.isPending}
                  success={mutation.isSuccess}
                  error={mutation.error}
                />
              </div>
            </fieldset>
          </form>
        </Form>
      </CardContent>
    </Card>
  )
}

function ReferralPolicySettings() {
  const policy = useQuery({
    queryKey: ['private-billing', 'referral-policy'],
    queryFn: () => apiClient.get<ReferralPolicy>('/api/private/billing/referrals/policy'),
  })
  if (policy.isPending)
    return <p className="text-sm text-muted-foreground">正在读取邀请奖励配置…</p>
  if (policy.isError)
    return (
      <div role="alert" className="flex items-center gap-3 text-sm text-destructive">
        邀请奖励配置读取失败
        <Button variant="outline" onClick={() => void policy.refetch()}>
          重试
        </Button>
      </div>
    )
  return <ReferralPolicyEditor policy={policy.data} />
}

function PlanEditor({ plan }: { plan: Plan }) {
  const queryClient = useQueryClient()
  const values: PlanValues = {
    name: plan.name,
    monthlyCredits: String(plan.monthly_credits),
    maxConcurrentTasks: String(plan.max_concurrent_tasks ?? 1),
    active: plan.active,
    prices: plan.prices.map((price) => ({
      periodMonths: price.period_months,
      original: String(price.original_price_cents),
      discount: price.discount_price_cents === null ? '' : String(price.discount_price_cents),
      discountEnds: price.discount_ends_at === null ? '' : toLocalInput(price.discount_ends_at),
    })),
  }
  const form = useForm<PlanValues>({ resolver: zodResolver(planSchema), defaultValues: values })
  useEffect(() => form.reset(values), [plan, form])
  const mutation = useMutation({
    mutationFn: (input: PlanValues) =>
      apiClient.put(`/api/private/billing/plans/${encodeURIComponent(plan.id)}`, {
        name: input.name,
        monthly_credits: Number(input.monthlyCredits),
        max_concurrent_tasks: Number(input.maxConcurrentTasks),
        active: input.active,
        sort_order: plan.sort_order,
        prices: input.prices.map((price) => ({
          period_months: price.periodMonths,
          original_price_cents: Number(price.original),
          discount_price_cents: price.discount === '' ? null : Number(price.discount),
          discount_ends_at: price.discountEnds === '' ? null : parseLocalInput(price.discountEnds),
        })),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['private-billing', 'catalog'] }),
  })

  return (
    <Form {...form}>
      <form
        noValidate
        onChange={() => mutation.reset()}
        onSubmit={form.handleSubmit((input) => mutation.mutate(input))}
      >
        <Card>
          <CardHeader className="p-4 pb-4 sm:p-6 sm:pb-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <CardTitle className="font-mono text-base">{plan.id}</CardTitle>
                <CardDescription>套餐显示、月度积分和各周期价格。</CardDescription>
              </div>
              <FormField
                control={form.control}
                name="active"
                render={({ field }) => (
                  <FormItem className="flex items-center gap-3 space-y-0">
                    <FormLabel className="cursor-pointer">启用套餐</FormLabel>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={(checked) => {
                          mutation.reset()
                          field.onChange(checked)
                        }}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>
          </CardHeader>
          <CardContent className="space-y-6 px-4 pb-4 sm:px-6 sm:pb-6">
            <div className="grid gap-5 md:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>套餐名称</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="maxConcurrentTasks"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>并发任务</FormLabel>
                    <FormControl>
                      <Input type="number" min="1" max="100" step="1" {...field} />
                    </FormControl>
                    <FormDescription>
                      修改积分或并发将发布新权益版本，旧订阅保持原权益。
                    </FormDescription>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="monthlyCredits"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>每月积分</FormLabel>
                    <FormControl>
                      <Input type="number" min="1" step="1" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="overflow-hidden rounded-lg border">
              <div className="hidden grid-cols-[80px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-3 bg-muted/50 px-4 py-2 text-xs font-medium text-muted-foreground lg:grid">
                <span>周期</span>
                <span>原价（分）</span>
                <span>优惠价（分）</span>
                <span>优惠截止</span>
              </div>
              <div className="divide-y">
                {values.prices.map((price, index) => (
                  <div
                    key={price.periodMonths}
                    className="grid grid-cols-2 items-start gap-3 px-3 py-3 lg:grid-cols-[80px_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)] lg:px-4"
                  >
                    <span className="col-span-2 text-sm font-medium lg:col-span-1 lg:pt-2">
                      {price.periodMonths} 个月
                    </span>
                    <FormField
                      control={form.control}
                      name={`prices.${index}.original`}
                      render={({ field }) => (
                        <FormItem className="lg:space-y-0">
                          <FormLabel className="text-xs lg:hidden">原价（分）</FormLabel>
                          <FormControl>
                            <Input
                              aria-label={`${price.periodMonths} 个月原价（分）`}
                              type="number"
                              min="0"
                              step="1"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage className="lg:!mt-2" />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`prices.${index}.discount`}
                      render={({ field }) => (
                        <FormItem className="lg:space-y-0">
                          <FormLabel className="text-xs lg:hidden">优惠价（分）</FormLabel>
                          <FormControl>
                            <Input
                              aria-label={`${price.periodMonths} 个月优惠价（分）`}
                              type="number"
                              min="0"
                              step="1"
                              placeholder="无"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage className="lg:!mt-2" />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`prices.${index}.discountEnds`}
                      render={({ field }) => (
                        <FormItem className="col-span-2 lg:col-span-1 lg:space-y-0">
                          <FormLabel className="text-xs lg:hidden">优惠截止</FormLabel>
                          <FormControl>
                            <Input
                              aria-label={`${price.periodMonths} 个月优惠截止`}
                              type="datetime-local"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage className="lg:!mt-2" />
                        </FormItem>
                      )}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="outline" disabled={mutation.isPending}>
                保存 {plan.id}
              </Button>
              <SaveStatus
                pending={mutation.isPending}
                success={mutation.isSuccess}
                error={mutation.error}
              />
            </div>
          </CardContent>
        </Card>
      </form>
    </Form>
  )
}

function SettingsPanel() {
  const catalog = useQuery({
    queryKey: ['private-billing', 'catalog'],
    queryFn: () => apiClient.get<Catalog>('/api/private/billing/catalog'),
  })
  if (catalog.isPending)
    return (
      <Card>
        <CardContent className="p-5 text-sm text-muted-foreground">正在读取计费设置…</CardContent>
      </Card>
    )
  if (catalog.isError)
    return (
      <Card className="border-destructive/40">
        <CardContent className="p-5 text-sm text-destructive">计费设置读取失败</CardContent>
      </Card>
    )
  return (
    <div className="space-y-6">
      <header className="border-b pb-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          Billing configuration
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">计费设置</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          低频高风险配置。修改将立即影响用户展示和后续任务结算。
        </p>
      </header>
      <SettingsEditor catalog={catalog.data} />
      <ReferralPolicySettings />
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">套餐与价格</h2>
          <p className="text-sm text-muted-foreground">
            每个套餐单独保存，未保存的修改不会影响其他套餐。
          </p>
        </div>
        {catalog.data.plans.map((plan) => (
          <PlanEditor key={plan.id} plan={plan} />
        ))}
      </section>
    </div>
  )
}

export { SettingsPanel }
