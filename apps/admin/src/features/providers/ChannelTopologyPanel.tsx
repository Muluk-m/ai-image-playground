import type { ManagedChannelSummary } from '@image-playground/shared'
import { EmptyState } from '@/components/Page'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

const KIND_LABELS: Record<ManagedChannelSummary['kind'], string> = {
  'openai-queue': 'OpenAI 队列协议',
  'gemini-queue': 'Gemini 原生协议',
}

export function ChannelTopologyPanel({ channels }: { channels: readonly ManagedChannelSummary[] }) {
  const activeCount = channels.filter((channel) => channel.status === 'active').length
  const unconfiguredCount = channels.filter((channel) => channel.status === 'unconfigured').length
  const disabledCount = channels.filter((channel) => channel.status === 'disabled').length

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-baseline justify-between gap-3 space-y-0 pb-3">
        <div>
          <CardTitle className="text-base">生成渠道拓扑（channels.json）</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            图片与视频上游分发通道只读快照；渠道顺序决定默认兜底优先级，密钥值可在「密钥池与预算」热更新。
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>启用 {activeCount}</span>
          {unconfiguredCount > 0 ? <span>· 待配凭证 {unconfiguredCount}</span> : null}
          {disabledCount > 0 ? <span>· 已下线 {disabledCount}</span> : null}
        </div>
      </CardHeader>
      <CardContent>
        {channels.length === 0 ? (
          <EmptyState label="当前未加载任何内置生成渠道" />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>渠道</TableHead>
                  <TableHead>协议与调度</TableHead>
                  <TableHead>并发与超时</TableHead>
                  <TableHead>绑定密钥引用</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>承载模型</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.map((channel) => (
                  <TableRow
                    key={channel.id}
                    className={channel.status === 'disabled' ? 'opacity-65' : undefined}
                  >
                    <TableCell className="min-w-[150px] align-top">
                      <div className="font-medium">{channel.label}</div>
                      <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {channel.id}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-[150px] align-top">
                      <div className="text-xs font-medium">{KIND_LABELS[channel.kind]}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {channel.asyncTasks ? '异步任务轮询' : '同步流/响应'} ·{' '}
                        {channel.authType === 'bearer' ? 'Bearer' : 'Query Key'}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-[130px] align-top font-mono text-xs">
                      <div>
                        {channel.maxConcurrency !== undefined
                          ? `渠道并发 ≤${channel.maxConcurrency}`
                          : '默认调度'}
                      </div>
                      {channel.timeoutSeconds ? (
                        <div className="mt-0.5 text-muted-foreground">
                          超时 {channel.timeoutSeconds}s
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="min-w-[160px] align-top">
                      <div className="font-mono text-xs">{channel.secretRef}</div>
                      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span
                          className={cn(
                            'size-2 rounded-full',
                            channel.secretConfigured ? 'bg-success' : 'bg-warning',
                          )}
                          aria-hidden
                        />
                        <span>{channel.secretConfigured ? '密钥已就绪' : '缺少密钥'}</span>
                      </div>
                    </TableCell>
                    <TableCell className="w-[110px] align-top">
                      {channel.status === 'active' ? (
                        <Badge variant="success">启用中</Badge>
                      ) : channel.status === 'unconfigured' ? (
                        <Badge variant="warning">待配凭证</Badge>
                      ) : (
                        <Badge variant="secondary">已下线</Badge>
                      )}
                    </TableCell>
                    <TableCell className="min-w-[260px] align-top">
                      <div className="flex flex-wrap gap-1.5">
                        {channel.models.map((model) => (
                          <div
                            key={model.id}
                            className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-0.5 text-xs"
                          >
                            <span className="font-medium">{model.label}</span>
                            <span className="text-muted-foreground">
                              {model.media === 'video' ? '视频' : '图片'}
                            </span>
                            {model.maxConcurrency !== undefined ? (
                              <span className="font-mono text-muted-foreground">
                                ≤{model.maxConcurrency}
                              </span>
                            ) : null}
                            {model.degraded ? <span className="text-warning">降级</span> : null}
                          </div>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
