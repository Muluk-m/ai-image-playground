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
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 pb-3">
        <CardTitle className="text-base">生成渠道拓扑（channels.json）</CardTitle>
        <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
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
                  <TableHead className="pl-4">渠道</TableHead>
                  <TableHead>协议与调度</TableHead>
                  <TableHead>并发与超时</TableHead>
                  <TableHead>绑定密钥引用</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="pr-4">承载模型</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {channels.map((channel) => (
                  <TableRow
                    key={channel.id}
                    className={channel.status === 'disabled' ? 'opacity-65' : undefined}
                  >
                    <TableCell className="min-w-[150px] py-3 pl-4 align-middle">
                      <div className="font-medium">{channel.label}</div>
                      <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                        {channel.id}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-[150px] py-3 align-middle">
                      <div className="text-xs font-medium">{KIND_LABELS[channel.kind]}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {channel.dispatchMode === 'dual'
                          ? '直连同步 / 网关异步'
                          : channel.dispatchMode === 'async' || channel.asyncTasks
                            ? '异步轮询'
                            : '同步响应'}{' '}
                        · {channel.authType === 'bearer' ? 'Bearer' : 'Query Key'}
                      </div>
                    </TableCell>
                    <TableCell className="min-w-[128px] py-3 align-middle font-mono text-xs">
                      <div>
                        {channel.maxConcurrency !== undefined
                          ? `并发 ≤${channel.maxConcurrency}`
                          : '默认调度'}
                      </div>
                      {channel.timeoutSeconds ? (
                        <div className="mt-0.5 text-muted-foreground">
                          超时 {channel.timeoutSeconds}s
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="min-w-[160px] py-3 align-middle">
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
                    <TableCell className="w-[104px] py-3 align-middle">
                      {channel.status === 'active' ? (
                        <Badge variant="success">启用中</Badge>
                      ) : channel.status === 'unconfigured' ? (
                        <Badge variant="warning">待配凭证</Badge>
                      ) : (
                        <Badge variant="secondary">已下线</Badge>
                      )}
                    </TableCell>
                    <TableCell className="min-w-[240px] py-3 pr-4 align-middle">
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
