/**
 * 生成路径上的停用要马上进告警轮询，但不能等 webhook 回来才换下一把 key。
 * worker 启动时把自己的那次扫描登记进来；没登记（测试、还没起来）就什么都不做。
 * 登记表是进程内的：只有 worker 进程登记，BFF HTTP 进程里的停用不会立刻触发。停用状态写在库里，
 * worker 的维护循环每 10 秒也会扫一遍，所以那种情况最多晚 10 秒发出，不会丢。
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
