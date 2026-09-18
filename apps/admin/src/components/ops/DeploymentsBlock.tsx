import { fuzzyTime, isoTime } from '@/lib/format'
import type { OpsDeployment, OpsDeployments } from '@/lib/types'

export function shortSha(sha: string): string {
  return sha.slice(0, 8)
}

/** 旧的部署记录里提交号是短的，心跳里是全的；按前缀比。 */
function sameCommit(a: string, b: string): boolean {
  const shorter = Math.min(a.length, b.length)
  return shorter >= 7 && a.slice(0, shorter) === b.slice(0, shorter)
}

/** 心跳里的版本（`<公开提交>` 或 `<公开提交>+<私有提交>`）是不是这次部署发的。 */
export function runsDeployment(version: string, entry: OpsDeployment): boolean {
  const [publicSha = '', privateSha] = version.split('+')
  if (!sameCommit(publicSha, entry.public_sha)) return false
  return (
    entry.private_sha === null ||
    (privateSha !== undefined && sameCommit(privateSha, entry.private_sha))
  )
}

/** 本套最近一次成功的部署；没有部署记录时为 null。 */
export function currentDeployment(deployments: OpsDeployments | null): OpsDeployment | null {
  if (!deployments?.available) return null
  return deployments.entries.find((entry) => entry.target === deployments.own && entry.ok) ?? null
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
