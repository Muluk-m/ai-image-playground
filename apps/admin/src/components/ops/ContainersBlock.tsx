import { bytes, shortId } from '@/lib/format'
import type { OpsContainer, OpsContainers } from '@/lib/types'

/** compose 起的名字都带着 `image-playground-` 前缀；去掉它，表格才放得下。 */
export function containerLabel(container: Pick<OpsContainer, 'name' | 'container_id'>): string {
  if (!container.name) return shortId(container.container_id, 12)
  return container.name.replace(/^image-playground-/, '')
}

export function containersProblems({ containers }: OpsContainers): string[] {
  return containers
    .filter((container) => container.recent_oom_kills > 0)
    .map(
      (container) =>
        `${containerLabel(container)} 近 24 小时有 ${container.recent_oom_kills} 个进程因内存不足被内核杀掉`,
    )
}

function cores(value: number | null): string {
  if (value === null) return '—'
  return value < 0.01 ? '<0.01 核' : `${value.toFixed(2)} 核`
}

export function ContainersBody({ containers, now }: { containers: OpsContainers; now: number }) {
  if (containers.sampled_at === null) {
    return (
      <p className="text-sm text-muted-foreground">
        还没有容器读数：采集容器没在跑，或者它还是不读 cgroup 的旧版本。
      </p>
    )
  }
  const stale = now - containers.sampled_at > 5 * 60 * 1000
  return (
    <div className="overflow-x-auto">
      {stale ? (
        <p className="mb-2 text-xs text-danger">这批读数已经过时，下面的数字不是现在的。</p>
      ) : null}
      <table className="w-full min-w-[520px] text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 pr-3 font-medium">容器</th>
            <th className="py-1 pr-3 text-right font-medium">CPU</th>
            <th className="py-1 pr-3 text-right font-medium">内存</th>
            <th className="py-1 pr-3 text-right font-medium">7 天峰值</th>
            <th className="py-1 text-right font-medium">OOM</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {containers.containers.map((container) => (
            <tr key={container.container_id}>
              <td
                className="max-w-[240px] truncate py-1.5 pr-3 font-mono"
                title={container.container_id}
              >
                {containerLabel(container)}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{cores(container.cpu_cores)}</td>
              <td className="py-2.5 pr-3 text-right tabular-nums">
                {bytes(container.mem_bytes)}
                {container.mem_limit_bytes !== null ? (
                  <span className="text-muted-foreground">
                    {' '}
                    / {bytes(container.mem_limit_bytes)}
                  </span>
                ) : null}
                <div
                  className="mt-1.5 ml-auto h-1.5 w-28 overflow-hidden rounded-full bg-muted"
                  role="img"
                  aria-label={`${containerLabel(container)} 内存使用 ${container.mem_limit_bytes ? Math.round((container.mem_bytes / container.mem_limit_bytes) * 100) + '%' : '相对当前最大容器'}`}
                >
                  <div
                    className="h-full bg-violet-500"
                    style={{
                      width: `${Math.min(100, (container.mem_bytes / (container.mem_limit_bytes || Math.max(1, ...containers.containers.map((one) => one.mem_bytes)))) * 100)}%`,
                    }}
                  />
                </div>
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-muted-foreground">
                {bytes(container.peak_mem_bytes)}
              </td>
              <td
                className={`py-1.5 text-right tabular-nums ${container.recent_oom_kills > 0 ? 'font-medium text-danger' : 'text-muted-foreground'}`}
              >
                {container.oom_kills}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] text-muted-foreground">
        整台宿主机上的全部容器，按当前内存排序；同机的另一套部署和数据库也在里面。
      </p>
    </div>
  )
}
