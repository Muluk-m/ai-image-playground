/**
 * 运维看板与告警共用的阈值。看板上变红的线与告警触发的线是同一条，
 * 否则运营者会看到「页面是绿的，群里却在响」。
 */
export const OPS_THRESHOLDS = {
  /** 最老的排队任务等待超过这个时长即视为积压。worker 每秒都在轮询，正常排队以秒计。 */
  QUEUE_WAIT_MS: 10 * 60 * 1000,
  /** 磁盘用量到这个比例就该处理了。50G 的盘上约剩 7G，与部署脚本 8G 的拒绝线基本对齐。 */
  DISK_USED_RATIO: 0.85,
  /** 采集每分钟一次；超过这个时长没有新读数，说明采集方自己出了问题，曲线已经过期。 */
  HOST_SAMPLE_MAX_AGE_MS: 5 * 60 * 1000,
  /** 心跳每 30 秒一次；超过这个时长没更新就当服务断了，也就是容忍连续丢 3 次。 */
  HEARTBEAT_MAX_AGE_MS: 2 * 60 * 1000,
  /** 备份每天一次；超过这个时长没有新文件就是断了。与备份容器自己的健康探针同一个数。 */
  BACKUP_MAX_AGE_MS: 26 * 60 * 60 * 1000,
  /** 最新一份备份比前一份小到这个比例以下，多半是 dump 半途而废，而不是数据真的少了。 */
  BACKUP_SHRINK_RATIO: 0.5,
} as const

/** 桶里的一份数据库备份。 */
export interface OpsBackupObject {
  key: string
  size_bytes: number
  modified_at: number
}

/** 后端内部接口 `/internal/admin/ops/backups` 的返回：最新一份与它的前一份，没有就是 null。 */
export interface OpsBackups {
  latest: OpsBackupObject | null
  previous: OpsBackupObject | null
}

/** 宿主机资源的一次读数。字节数；`sampled_at` 是毫秒时间戳。 */
export interface HostSample {
  sampled_at: number
  disk_total_bytes: number
  disk_available_bytes: number
  mem_total_bytes: number
  mem_available_bytes: number
}
