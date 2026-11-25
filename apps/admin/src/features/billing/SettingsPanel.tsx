import { zodResolver } from '@hookform/resolvers/zod'
import type { Catalog, Plan, ReferralPolicy } from '@image-playground/shared'
import { MAX_CREDIT_BALANCE } from '@image-playground/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, QrCode } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { ApiError } from '@/lib/api-client'
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
import { centsToYuanInput, previewReferralCredits, yuanInputToCents } from './model-price'
import { credits, money, parseLocalInput, toLocalInput } from './shared'

const requiredInteger = z.string().trim().regex(/^\d+$/, '请输入整数')
const positiveInteger = requiredInteger.refine((value) => Number(value) > 0, '必须大于 0')
const yuanAmount = z
  .string()
  .trim()
  .regex(/^\d+(?:\.\d{1,2})?$/, '请输入元金额（最多两位小数）')
const optionalYuanAmount = z
  .string()
  .trim()
  .refine((value) => value === '' || /^\d+(?:\.\d{1,2})?$/.test(value), '最多保留两位小数')

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
        originalYuan: yuanAmount,
        discountYuan: optionalYuanAmount,
        discountEnds: z.string(),
      })
      .superRefine((price, context) => {
        if (price.discountYuan !== '' && price.discountEnds === '') {
          context.addIssue({
            code: 'custom',
            message: '请选择优惠截止时间',
            path: ['discountEnds'],
          })
        }
        const orig = yuanInputToCents(price.originalYuan)
        const disc = yuanInputToCents(price.discountYuan)
        if (orig !== null && disc !== null && !Number.isNaN(orig) && !Number.isNaN(disc)) {
          if (disc > orig) {
            context.addIssue({
              code: 'custom',
              message: '优惠价不能高于原价',
              path: ['discountYuan'],
            })
          }
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
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return '登录已失效或无权限，请刷新后重试'
    if (error.status === 409) return '配置已被他人更新，请刷新后重试'
    if (error.status === 400 || error.status === 422) return '填写的参数无效，请检查后重试'
    if (error.status >= 500) return '服务暂不可用，请稍后重试'
    return '保存失败，请重试'
  }
  return '保存失败，请重试'
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
      <span className="text-xs text-danger" role="alert">
        {errorMessage(error)}
      </span>
    )
  if (success) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-success" role="status">
        <CheckCircle2 className="h-3.5 w-3.5" />
        已保存
      </span>
    )
  }
  return null
}

function LiveQrPreview({
  paymentsEnabled,
  paymentChannel,
  paymentQrUrl,
  contactQrUrl,
  contactWechat,
  guidance,
}: {
  paymentsEnabled: boolean
  paymentChannel: 'wechat' | 'alipay'
  paymentQrUrl: string
  contactQrUrl: string
  contactWechat: string
  guidance: string
}) {
  const [mode, setMode] = useState<'payment' | 'contact'>('payment')
  const [imageState, setImageState] = useState<'idle' | 'ok' | 'error'>('idle')
  const activeUrl = (mode === 'payment' ? paymentQrUrl : contactQrUrl).trim()
  const isAbsolutePreviewable = /^(?:https?:\/\/|data:image\/)/i.test(activeUrl)

  useEffect(() => {
    setImageState('idle')
  }, [activeUrl, mode])

  return (
    <div className="flex flex-col justify-between rounded-xl bg-brand-ink p-4 text-primary-foreground">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            收银台实时预览
          </span>
          <div className="flex rounded-md bg-brand-ink-raised p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setMode('payment')}
              className={[
                'rounded px-2 py-0.5 transition-colors',
                mode === 'payment'
                  ? 'bg-brand text-brand-foreground font-medium'
                  : 'text-muted-foreground',
              ].join(' ')}
            >
              收款码
            </button>
            <button
              type="button"
              onClick={() => setMode('contact')}
              className={[
                'rounded px-2 py-0.5 transition-colors',
                mode === 'contact'
                  ? 'bg-brand text-brand-foreground font-medium'
                  : 'text-muted-foreground',
              ].join(' ')}
            >
              客服码
            </button>
          </div>
        </div>

        <div className="rounded-lg bg-card p-4 text-card-foreground">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold">
              {mode === 'payment'
                ? paymentChannel === 'alipay'
                  ? '支付宝扫码付款'
                  : '微信扫码付款'
                : '联系人工客服'}
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs">
              <span
                className={[
                  'h-2 w-2 rounded-full',
                  paymentsEnabled ? 'bg-success' : 'bg-warning',
                ].join(' ')}
                aria-hidden
              />
              {paymentsEnabled ? '收款开启' : '维护暂停'}
            </span>
          </div>

          <div className="mt-3 flex min-h-[168px] flex-col items-center justify-center rounded-lg border border-dashed bg-muted/40 p-3 text-center">
            {!activeUrl ? (
              <div className="space-y-1.5 text-xs text-muted-foreground">
                <QrCode className="mx-auto h-7 w-7 opacity-50" />
                <p>
                  {mode === 'payment'
                    ? '未填写收款码 URL'
                    : `未填客服二维码，将回退显示微信号：${contactWechat.trim() || '未配置'}`}
                </p>
              </div>
            ) : !isAbsolutePreviewable ? (
              <div className="space-y-1.5 rounded-md border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs text-warning">
                <p className="font-medium">相对路径无法在管理端校验真图</p>
                <p className="text-[11px] leading-relaxed">
                  相对地址（如 /op/...）将按用户端主站域名解析；请改用完整 https://
                  对象存储外链以确保预览与用户端一致。
                </p>
              </div>
            ) : (
              <>
                <img
                  key={`${mode}:${activeUrl}`}
                  src={activeUrl}
                  alt={mode === 'payment' ? '收款二维码预览' : '客服二维码预览'}
                  className={[
                    'h-36 w-36 rounded-md bg-background object-contain p-1',
                    imageState === 'error' ? 'hidden' : '',
                  ].join(' ')}
                  onLoad={() => setImageState('ok')}
                  onError={() => setImageState('error')}
                />
                {imageState === 'error' ? (
                  <p className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2 text-xs text-danger">
                    图片加载失败，请核对 URL 可访问后再开放收款
                  </p>
                ) : null}
              </>
            )}
          </div>

          {guidance.trim() ? (
            <p className="mt-3 line-clamp-3 rounded-md bg-muted px-2.5 py-2 text-xs text-muted-foreground">
              {guidance.trim()}
            </p>
          ) : null}
        </div>
      </div>

      <p className="mt-3 text-[11px] text-muted-foreground">
        换码请始终使用新的图片文件名 / URL，确保历史待核款订单仍能查看当时展示的旧码。
      </p>
    </div>
  )
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
  const watched = form.watch()

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
      <CardHeader className="pb-4">
        <CardTitle className="text-base">收款通道与客服引导</CardTitle>
        <CardDescription>
          管理自助续费收款开关、渠道标识与二维码；右侧实时预览客户端收银台并校验二维码可访问性。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
          <Form {...form}>
            <form
              className="grid gap-4 md:grid-cols-2"
              noValidate
              onChange={() => mutation.reset()}
              onSubmit={form.handleSubmit((input) => mutation.mutate(input))}
            >
              <FormField
                control={form.control}
                name="paymentsEnabled"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3 space-y-0">
                    <div>
                      <FormLabel className="cursor-pointer">开放自助续费付款</FormLabel>
                      <FormDescription className="mt-0.5 text-xs">
                        换码期间先关闭，右侧预览无误后再开启。
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
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
                      <Input {...field} placeholder="与账单流水中对应的收款账户名" />
                    </FormControl>
                    <FormDescription className="text-xs">
                      同一收款户换二维码时保持不变，用于核款去重。
                    </FormDescription>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="contactWechat"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>联系微信号</FormLabel>
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
                    <FormLabel>收款码图片 URL</FormLabel>
                    <FormControl>
                      <Input
                        className="font-mono text-xs"
                        placeholder="https://assets.example.com/pay-qr.jpg"
                        {...field}
                      />
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
                    <FormLabel>客服二维码 URL</FormLabel>
                    <FormControl>
                      <Input
                        className="font-mono text-xs"
                        placeholder="https://assets.example.com/contact-qr.jpg"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="guidance"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>付款说明文案</FormLabel>
                    <FormControl>
                      <Textarea rows={3} placeholder="付款后请提供订单码或用户名" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex items-center gap-3 md:col-span-2">
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

          <LiveQrPreview
            paymentsEnabled={watched.paymentsEnabled}
            paymentChannel={watched.paymentChannel}
            paymentQrUrl={watched.paymentQrUrl}
            contactQrUrl={watched.contactQrUrl}
            contactWechat={watched.contactWechat}
            guidance={watched.guidance}
          />
        </div>
      </CardContent>
    </Card>
  )
}

function ReferralPolicyEditor({ policy }: { policy: ReferralPolicy }) {
  const queryClient = useQueryClient()
  const [sampleYuan, setSampleYuan] = useState('99')
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
  const watched = form.watch()

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

  const sampleReward = previewReferralCredits({
    paymentYuan: Number(sampleYuan),
    percent: Number(watched.percent),
    creditsPerYuan: Number(watched.creditsPerYuan),
  })

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-base">邀请裂变与返利策略</CardTitle>
        <CardDescription>
          全站统一策略，仅对修改后的新注册与新核款生效，不回溯历史账本。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit((input) => mutation.mutate(input))}
              onChange={() => mutation.reset()}
              noValidate
            >
              <fieldset disabled={mutation.isPending} className="grid gap-4 md:grid-cols-2">
                {(
                  [
                    {
                      name: 'inviterCredits',
                      label: '邀请人注册奖励（积分）',
                      description: '自动入账消费积分；设 0 关闭。',
                      step: '1',
                      min: '0',
                      max: MAX_CREDIT_BALANCE,
                    },
                    {
                      name: 'inviteeCredits',
                      label: '受邀人注册奖励（积分）',
                      description: '独立于开户赠送；设 0 关闭。',
                      step: '1',
                      min: '0',
                      max: MAX_CREDIT_BALANCE,
                    },
                    {
                      name: 'percent',
                      label: '实付返利比例（%）',
                      description: '覆盖会员开通、续费与单次充值；设 0 关闭。',
                      step: '0.01',
                      min: '0',
                      max: 100,
                    },
                    {
                      name: 'creditsPerYuan',
                      label: '返利折算率（积分 / 元）',
                      description: '每笔返利按此汇率向下取整为整数积分。',
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
                          <Input type="number" className="font-mono" {...limits} {...field} />
                        </FormControl>
                        <FormDescription className="text-xs">{description}</FormDescription>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                ))}
                <div className="flex items-center gap-3 md:col-span-2">
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

          <div className="flex flex-col justify-between rounded-xl border bg-muted/30 p-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold">实时返利试算</span>
                <div className="flex gap-1">
                  {['29', '99', '299'].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setSampleYuan(preset)}
                      className={[
                        'rounded border px-2 py-0.5 font-mono text-xs transition-colors',
                        sampleYuan === preset
                          ? 'border-foreground bg-foreground text-background'
                          : 'bg-background text-muted-foreground hover:text-foreground',
                      ].join(' ')}
                    >
                      ¥{preset}
                    </button>
                  ))}
                </div>
              </div>

              <label className="block space-y-1 text-xs text-muted-foreground">
                <span>模拟受邀人实付金额（元）</span>
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={sampleYuan}
                  onChange={(event) => setSampleYuan(event.target.value)}
                  className="h-8 bg-background font-mono text-xs text-foreground"
                />
              </label>

              <div className="space-y-2 rounded-lg border bg-background p-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">新用户注册入账</span>
                  <span className="font-mono font-medium">
                    邀 +{credits(Number(watched.inviterCredits) || 0)} / 受 +
                    {credits(Number(watched.inviteeCredits) || 0)}
                  </span>
                </div>
                <div className="flex items-center justify-between border-t pt-2">
                  <span className="text-muted-foreground">
                    实付 ¥{sampleYuan || '0'} 邀请人获赠
                  </span>
                  <span className="font-mono text-sm font-semibold text-foreground">
                    {sampleReward === null ? (
                      <span className="text-warning">超出计算上限</span>
                    ) : (
                      `+${credits(sampleReward)} 积分`
                    )}
                  </span>
                </div>
              </div>
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              计算公式：⌊实付元 × {watched.percent || 0}% × {watched.creditsPerYuan || 0}⌋
            </p>
          </div>
        </div>
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
      <div role="alert" className="flex items-center gap-3 text-sm text-danger">
        邀请奖励配置读取失败
        <Button variant="outline" onClick={() => void policy.refetch()}>
          重试
        </Button>
      </div>
    )
  return <ReferralPolicyEditor policy={policy.data} />
}

function PlanCard({
  plan,
  rechargeRate,
  onEdit,
}: {
  plan: Plan
  rechargeRate?: number
  onEdit: () => void
}) {
  const now = Date.now()
  return (
    <Card className="flex flex-col justify-between">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{plan.name}</CardTitle>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">{plan.id}</p>
          </div>
          <span className="inline-flex items-center gap-1.5 text-xs font-medium">
            <span
              className={[
                'h-2 w-2 rounded-full',
                plan.active ? 'bg-success' : 'bg-muted-foreground/40',
              ].join(' ')}
              aria-hidden
            />
            {plan.active ? '在售' : '已停用'}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <span className="rounded-md bg-muted px-2 py-0.5 font-mono font-medium">
            {credits(plan.monthly_credits)} 积分/月
          </span>
          <span className="rounded-md bg-muted px-2 py-0.5 font-mono text-muted-foreground">
            并发 ≤{plan.max_concurrent_tasks ?? 1}
          </span>
        </div>
      </CardHeader>

      <CardContent className="space-y-3 pt-0">
        <div className="divide-y rounded-lg border text-xs">
          {plan.prices.map((price) => {
            const hasActiveDiscount =
              price.discount_price_cents !== null &&
              price.discount_ends_at !== null &&
              price.discount_ends_at > now &&
              price.discount_price_cents < price.original_price_cents
            const totalCredits = plan.monthly_credits * price.period_months
            const effectiveYuan = price.effective_price_cents / 100
            const yieldPerYuan = effectiveYuan > 0 ? Math.round(totalCredits / effectiveYuan) : null

            return (
              <div
                key={price.period_months}
                className="flex items-center justify-between gap-2 px-3 py-2"
              >
                <div>
                  <span className="font-medium">{price.period_months} 个月</span>
                  {hasActiveDiscount ? (
                    <span className="ml-1.5 text-[11px] text-success">优惠中</span>
                  ) : price.discount_price_cents !== null ? (
                    <span className="ml-1.5 text-[11px] text-muted-foreground">优惠已过期</span>
                  ) : null}
                </div>
                <div className="text-right font-mono">
                  <span className="font-semibold text-foreground">
                    {money(price.effective_price_cents)}
                  </span>
                  {hasActiveDiscount ? (
                    <span className="ml-1.5 text-muted-foreground line-through">
                      {money(price.original_price_cents)}
                    </span>
                  ) : null}
                  {yieldPerYuan !== null ? (
                    <span
                      className={[
                        'ml-2 text-[11px]',
                        rechargeRate && yieldPerYuan < rechargeRate
                          ? 'text-warning'
                          : 'text-muted-foreground',
                      ].join(' ')}
                    >
                      ({yieldPerYuan}分/元)
                    </span>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>

        <Button type="button" size="sm" variant="outline" className="w-full" onClick={onEdit}>
          编辑套餐与价格
        </Button>
      </CardContent>
    </Card>
  )
}

function PlanDrawerEditor({ plan, onClose }: { plan: Plan; onClose: () => void }) {
  const queryClient = useQueryClient()
  const values: PlanValues = {
    name: plan.name,
    monthlyCredits: String(plan.monthly_credits),
    maxConcurrentTasks: String(plan.max_concurrent_tasks ?? 1),
    active: plan.active,
    prices: plan.prices.map((price) => ({
      periodMonths: price.period_months,
      originalYuan: centsToYuanInput(price.original_price_cents),
      discountYuan: centsToYuanInput(price.discount_price_cents),
      discountEnds: price.discount_ends_at === null ? '' : toLocalInput(price.discount_ends_at),
    })),
  }
  const form = useForm<PlanValues>({ resolver: zodResolver(planSchema), defaultValues: values })
  useEffect(() => form.reset(values), [plan, form])

  const watchedPrices = form.watch('prices')
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
          original_price_cents: yuanInputToCents(price.originalYuan) ?? 0,
          discount_price_cents: yuanInputToCents(price.discountYuan),
          discount_ends_at: price.discountEnds === '' ? null : parseLocalInput(price.discountEnds),
        })),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['private-billing', 'catalog'] })
      onClose()
    },
  })

  const [confirmDiscard, setConfirmDiscard] = useState(false)

  useEffect(() => {
    if (!form.formState.isDirty && confirmDiscard) setConfirmDiscard(false)
  }, [form.formState.isDirty, confirmDiscard])

  const requestClose = () => {
    if (mutation.isPending) return
    if (!form.formState.isDirty) {
      onClose()
      return
    }
    setConfirmDiscard(true)
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) requestClose()
      }}
    >
      <SheetContent
        aria-label={`编辑套餐 ${plan.name}`}
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[576px]"
      >
        <SheetHeader className="border-b px-6 py-4 text-left">
          <SheetDescription className="font-mono text-xs">{plan.id}</SheetDescription>
          <SheetTitle className="mt-0.5 text-lg">编辑套餐：{plan.name}</SheetTitle>
        </SheetHeader>

        <Form {...form}>
          <form
            className="flex min-h-0 flex-1 flex-col"
            noValidate
            onChange={() => mutation.reset()}
            onSubmit={form.handleSubmit((input) => mutation.mutate(input))}
          >
            <div className="flex-1 space-y-5 overflow-y-auto p-6">
              <FormField
                control={form.control}
                name="active"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-lg border bg-muted/20 p-3 space-y-0">
                    <div>
                      <FormLabel className="cursor-pointer">在定价页开放购买</FormLabel>
                      <FormDescription className="text-xs">
                        停用后不影响存量有效订阅的到期日与月度发分。
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                  </FormItem>
                )}
              />

              <div className="grid gap-4 sm:grid-cols-3">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>显示名称</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
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
                        <Input type="number" min="1" step="1" className="font-mono" {...field} />
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
                      <FormLabel>并发任务上限</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min="1"
                          max="100"
                          step="1"
                          className="font-mono"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                调整每月积分或并发上限将生成新权益快照，旧订阅在当期保持原权益。
              </p>

              <div className="space-y-3">
                <div className="flex items-baseline justify-between">
                  <h3 className="text-sm font-semibold">各周期定价（单位：人民币元 ¥）</h3>
                  <span className="text-xs text-muted-foreground">保存时自动精确换算为分</span>
                </div>
                {values.prices.map((price, index) => {
                  const watchedRow = watchedPrices?.[index]
                  const origCents = yuanInputToCents(watchedRow?.originalYuan ?? '')
                  const discCents = yuanInputToCents(watchedRow?.discountYuan ?? '')
                  const endsRaw = watchedRow?.discountEnds?.trim() ?? ''
                  const endsTs = endsRaw === '' ? null : parseLocalInput(endsRaw)
                  const discountActive =
                    discCents !== null &&
                    !Number.isNaN(discCents) &&
                    endsTs !== null &&
                    !Number.isNaN(endsTs) &&
                    endsTs > Date.now()
                  const effectiveCents = discountActive ? discCents : origCents

                  return (
                    <div key={price.periodMonths} className="space-y-3 rounded-lg border p-3.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold">{price.periodMonths} 个月周期</span>
                        {effectiveCents !== null && !Number.isNaN(effectiveCents) ? (
                          <span className="font-mono text-muted-foreground">
                            入库 {effectiveCents} 分 · 月均{' '}
                            {money(Math.round(effectiveCents / price.periodMonths))}
                          </span>
                        ) : null}
                      </div>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <FormField
                          control={form.control}
                          name={`prices.${index}.originalYuan`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs">原价（元）</FormLabel>
                              <FormControl>
                                <Input
                                  aria-label={`${price.periodMonths} 个月原价（元）`}
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  className="font-mono"
                                  {...field}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name={`prices.${index}.discountYuan`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs">限时优惠价（元）</FormLabel>
                              <FormControl>
                                <Input
                                  aria-label={`${price.periodMonths} 个月优惠价（元）`}
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  placeholder="无优惠"
                                  className="font-mono"
                                  {...field}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name={`prices.${index}.discountEnds`}
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel className="text-xs">优惠截止时间</FormLabel>
                              <FormControl>
                                <Input
                                  aria-label={`${price.periodMonths} 个月优惠截止`}
                                  type="datetime-local"
                                  className="text-xs"
                                  {...field}
                                />
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="space-y-3 border-t bg-background px-6 py-4">
              {confirmDiscard && !mutation.isPending ? (
                <div
                  role="alertdialog"
                  aria-label="放弃未保存修改？"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs"
                >
                  <span className="text-foreground">有未保存的套餐价格修改，确定关闭？</span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirmDiscard(false)}
                    >
                      继续编辑
                    </Button>
                    <Button type="button" size="sm" variant="destructive" onClick={onClose}>
                      放弃并关闭
                    </Button>
                  </div>
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-3">
                <SaveStatus
                  pending={mutation.isPending}
                  success={mutation.isSuccess}
                  error={mutation.error}
                />
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={mutation.isPending}
                    onClick={requestClose}
                  >
                    取消
                  </Button>
                  <Button
                    type="submit"
                    className="bg-brand text-brand-foreground hover:bg-brand-hover"
                    disabled={mutation.isPending}
                  >
                    保存 {plan.name}
                  </Button>
                </div>
              </div>
            </div>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}

function SettingsPanel() {
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null)
  const catalog = useQuery({
    queryKey: ['private-billing', 'catalog'],
    queryFn: () => apiClient.get<Catalog>('/api/private/billing/catalog'),
  })
  const referralQuery = useQuery({
    queryKey: ['private-billing', 'referral-policy'],
    queryFn: () => apiClient.get<ReferralPolicy>('/api/private/billing/referrals/policy'),
  })

  if (catalog.isPending)
    return (
      <Card>
        <CardContent className="p-5 text-sm text-muted-foreground">正在读取计费设置…</CardContent>
      </Card>
    )
  if (catalog.isError)
    return (
      <Card className="border-danger/40">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5 text-sm text-danger">
          <span>计费设置读取失败</span>
          <Button type="button" size="sm" variant="outline" onClick={() => void catalog.refetch()}>
            重试
          </Button>
        </CardContent>
      </Card>
    )

  const plans = catalog.data.plans
  const activePlans = plans.filter((plan) => plan.active).length
  const recharge = catalog.data.recharge_pricing
  const paymentsEnabled = catalog.data.settings?.payments_enabled ?? false
  const channelLabel = catalog.data.settings?.payment_channel === 'alipay' ? '支付宝' : '微信'
  const editingPlan = plans.find((item) => item.id === editingPlanId) ?? null

  return (
    <div className="space-y-6">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="商业配置概览">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              自助收款状态
            </p>
            <p
              className={[
                'mt-3 font-mono text-2xl font-semibold tabular-nums',
                paymentsEnabled ? 'text-success' : 'text-warning',
              ].join(' ')}
            >
              {paymentsEnabled ? '已开放' : '维护暂停'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">当前渠道：{channelLabel}扫码核款</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              在售会员套餐
            </p>
            <p className="mt-3 font-mono text-2xl font-semibold tabular-nums">
              {activePlans} / {plans.length}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">各档独立权益快照，修改即时生效</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              单次充值汇率
            </p>
            <p className="mt-3 font-mono text-2xl font-semibold tabular-nums">
              {recharge ? `${recharge.credits_per_yuan} 分/元` : '—'}
            </p>
            <p className="mt-1 truncate text-xs text-muted-foreground">
              {recharge
                ? `档位：${recharge.amounts_yuan.map((y) => `¥${y}`).join(' / ')}`
                : '按配置文件生效'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              裂变实付返利
            </p>
            <p className="mt-3 font-mono text-2xl font-semibold tabular-nums">
              {referralQuery.data ? `${referralQuery.data.paid_reward_basis_points / 100}%` : '…'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {referralQuery.data
                ? `注册送 邀+${referralQuery.data.inviter_registration_credits} / 受+${referralQuery.data.invitee_registration_credits}`
                : '读取邀请策略中'}
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold">会员订阅套餐矩阵</h2>
            <p className="text-xs text-muted-foreground">
              点击任一套餐在右侧抽屉以「元」为单位调整周期定价；若套餐折算低于单次充值汇率将自动标黄提示。
            </p>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {plans.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              rechargeRate={recharge?.credits_per_yuan}
              onEdit={() => setEditingPlanId(plan.id)}
            />
          ))}
        </div>
        {recharge ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/20 px-4 py-3 text-xs">
            <span className="font-medium text-muted-foreground">
              单次加油包充值档位（随部署配置只读生效）：
            </span>
            <div className="flex flex-wrap gap-2 font-mono">
              {recharge.amounts_yuan.map((yuan) => (
                <span key={yuan} className="rounded border bg-background px-2 py-0.5">
                  ¥{yuan} → {credits(yuan * recharge.credits_per_yuan)} 积分
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <SettingsEditor catalog={catalog.data} />
      <ReferralPolicySettings />

      {editingPlan ? (
        <PlanDrawerEditor plan={editingPlan} onClose={() => setEditingPlanId(null)} />
      ) : null}
    </div>
  )
}

export { SettingsPanel }
