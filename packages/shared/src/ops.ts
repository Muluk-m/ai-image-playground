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
  /** 可用内存低于这个比例算吃紧。 */
  MEMORY_AVAILABLE_RATIO: 0.1,
  /** 内存要持续吃紧这么久才告警；一次瞬时偏低是常态，不值得叫人。 */
  MEMORY_SUSTAIN_MS: 5 * 60 * 1000,
  /**
   * 低于这个比例不等持续期，立刻告警。2026-09-18 那次，可用内存一分钟内从 56% 掉到 1%，
   * 机器随即卡死九个小时，5 分钟的持续期一分钟都没走完，一条告警也没发出去。
   */
  MEMORY_CRITICAL_RATIO: 0.03,
  /** CPU 使用率（整机、所有核的平均）到这个比例算吃紧；看板标红，不告警。 */
  CPU_BUSY_RATIO: 0.9,
  /** 这么久之内开过机，看板会提示「机器刚重启过」。 */
  RECENT_BOOT_MS: 60 * 60 * 1000,
  /** 最近这段时间 5xx 占比超过这个比例、且请求数不少于下面的数，看板标红。 */
  API_SERVER_ERROR_RATIO: 0.05,
  API_MIN_REQUESTS_FOR_RATIO: 20,
  /** 看板判断「最近」接口情况的窗口。 */
  API_RECENT_WINDOW_MS: 15 * 60 * 1000,
  /** 心跳每 30 秒一次；超过这个时长没更新就当服务断了，也就是容忍连续丢 3 次。 */
  HEARTBEAT_MAX_AGE_MS: 2 * 60 * 1000,
  /**
   * 磁盘与内存报过之后，要回到告警线内侧这么多个百分点才算恢复。读数贴着告警线浮动时，
   * 没有这道余量就会每分钟交替发「告警」与「已恢复」。
   */
  HOST_RECOVERY_MARGIN_RATIO: 0.02,
  /** Hourly cloud backup; tolerate one delayed run, matching the sidecar health probe. */
  BACKUP_MAX_AGE_MS: 2 * 60 * 60 * 1000,
  /**
   * 备份恢复演练每周一次；超过这个时长没有新结果就是断了。比一周多留一天，
   * 给周日那一轮失手后容器重启时的补跑留出余地。
   */
  RESTORE_DRILL_MAX_AGE_MS: 8 * 24 * 60 * 60 * 1000,
  /** 最新一份备份比前一份小到这个比例以下，多半是 dump 半途而废，而不是数据真的少了。 */
  BACKUP_SHRINK_RATIO: 0.5,
} as const

/** 桶里的一份数据库备份。 */
export interface OpsBackupObject {
  key: string
  size_bytes: number
  modified_at: number
}

/**
 * 最近一次备份恢复演练的结果：pg-backup 容器把最新一份 dump 恢复进一个临时库、核对之后，
 * 写到桶里的 `pg/drill/latest.json`。`error` 只在没通过时有值。
 */
export interface OpsRestoreDrill {
  ok: boolean
  finished_at: number
  error: string | null
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
  /**
   * 下面几项是后来加的，旧采集容器报上来的读数没有它们，所以都可以缺席。
   * `cpu_busy_ratio` 要两次读数才算得出，采集容器刚起来的第一次也是空的。
   */
  cpu_count?: number | null
  cpu_busy_ratio?: number | null
  load_1?: number | null
  load_5?: number | null
  load_15?: number | null
  swap_total_bytes?: number | null
  swap_free_bytes?: number | null
  /** 宿主机上次开机的时刻，毫秒。 */
  booted_at?: number | null
  /** 同一时刻各容器的读数。 */
  containers?: ContainerSample[]
}

/**
 * 一个容器在某一时刻的资源读数，来自宿主机的 cgroup。名字来自部署脚本写下的对照表，
 * 对照表里没有（例如部署之外重建的容器）就是 null，看板用容器 ID 的前 12 位代替。
 */
export interface ContainerSample {
  container_id: string
  name: string | null
  /** 不含可回收的文件缓存，与 `docker stats` 的口径一致。 */
  mem_bytes: number
  /** 容器的内存上限；没设就是 null。 */
  mem_limit_bytes: number | null
  /** 两次读数之间平均用了几个核；第一次读数算不出，为 null。 */
  cpu_cores: number | null
  /** 容器起来以来被内核因内存不足杀掉进程的次数。 */
  oom_kills: number
}
