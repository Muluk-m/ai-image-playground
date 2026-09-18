import { fuzzyTime, isoTime } from '@/lib/format'
import type { OpsDeployment, OpsDeployments } from '@/lib/types'

export function shortSha(sha: string): string {
  return sha.slice(0, 8)
}

export function deploymentsProblems({ own, entries }: OpsDeployments): string[] {
  const latestOwn = entries.find((entry) => entry.target === own)
  if (latestOwn && !latestOwn.ok) {
    return [`本套最近一次部署失败了（${fuzzyTime(latestOwn.at)}），线上还是之前的版本`]
  }
  return []
}

function version(entry: OpsDeployment): string {
  return entry.private_sha
    ? `${shortSha(entry.public_sha)}+${shortSha(entry.private_sha)}`
    : shortSha(entry.public_sha)
}

export function DeploymentsBody({
  deployments,
  now,
}: {
  deployments: OpsDeployments
  now: number
}) {
  if (!deployments.available) {
    return (
      <p className="text-sm text-muted-foreground">
        读不到部署记录：这套部署不是用部署脚本发的，或者部署日志没有挂进后台容器。
      </p>
    )
  }
  return (
    <ul className="space-y-1.5 text-xs">
      {deployments.entries.map((entry) => (
        <li
          key={`${entry.at}-${entry.target}`}
          className="grid grid-cols-[5.5rem_1fr_auto] items-baseline gap-3"
        >
          <span className="tabular-nums text-muted-foreground" title={`${isoTime(entry.at)} UTC`}>
            {fuzzyTime(entry.at, now)}
          </span>
          <span className="truncate">
            <span className={entry.target === deployments.own ? 'font-medium' : ''}>
              {entry.target}
            </span>
            {entry.target === deployments.own ? (
              <span className="ml-1 text-muted-foreground">（本套）</span>
            ) : null}
            <span className="ml-2 font-mono text-muted-foreground" title={entry.image}>
              {version(entry)}
            </span>
          </span>
          <span className={entry.ok ? 'text-success' : 'font-medium text-danger'}>
            {entry.ok ? '成功' : '失败'}
          </span>
        </li>
      ))}
    </ul>
  )
}
