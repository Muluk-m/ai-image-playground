/**
 * 生成路径上的停用要马上进告警轮询，但不能等 webhook 回来才换下一把 key。
 * worker 启动时把自己的那次扫描登记进来；没登记（测试、还没起来）就什么都不做。
 */
type AlertScan = () => Promise<void>

let scan: AlertScan | undefined

export function registerAppAlertScan(next?: AlertScan): void {
  scan = next
}

/** 有扫描在跑就让它结束再跑一轮；否则立刻开一轮，调用方不等。 */
export function kickAppAlerts(): void {
  const current = scan
  if (current) void current()
}
