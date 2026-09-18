# R2 冷恢复与固定 API 入口

决策日期：2026-09-18。生产保持 Pages + VPS；macmini2 负责构建和按需恢复，**不做备用 PG 定时同步**。

## 已实现的恢复工具

- `scripts/recovery-bundle.ts`：显式文件清单 → AES-256-GCM 加密 → R2 上传 → 回读 SHA-256 校验 → 最后发布完成标记。包包含 PG custom dump、应用与迁移配置、operator 配置、Tunnel 配置，以及公开/私有提交、运行镜像 ID、PG 主版本。普通业务资源仍留在 R2，不打入包。
- `list` 从 R2 找完成包；`fetch` 下载、验完整性、解密到**全新**的 0700 目录，文件为 0600。不会执行配置、连接数据库或启动服务。错误密钥、篡改、路径穿越、重复路径和已有目标均拒绝。
- `scripts/restore-recovery-db.sh`：仅在 Mac 上创建全新的 `aip-recovery-check-*` PG 17 容器。无网络、无端口、无 BFF/worker，单事务恢复后输出逐表计数，停止并保留容器/卷供核对。**这不是生产接管命令**。
- PG sidecar 改为每小时唯一命名备份，`.dump.sha256` 最后上传，恢复演练只接受已完成并校验通过的 dump。启动从 R2 取真实成功时间，不再 `touch` 伪造成功；超过两小时未成功即健康失败。

现有打包器限输入合计 64 MiB，适用于当前小库和配置。达到限制会明确失败；升级流式加密前不得截断数据。镜像层不进入此包，必须另保留完整发布包与 SHA256SUMS；只有镜像 ID 并不能在 VPS 丢失后重新获取镜像。

## 独立启动凭据

外置 bootstrap JSON（0600），字段如下，不得提交真实值：

```json
{
  "endpoint": "https://ACCOUNT.r2.cloudflarestorage.com",
  "bucket": "PRIVATE_RECOVERY_BUCKET",
  "accessKeyId": "READ_ONLY_RECOVERY_CREDENTIAL",
  "secretAccessKey": "SECRET",
  "prefix": "recovery-v1/paid/",
  "keyFile": "/protected/recovery.key"
}
```

上传者需写权限，macmini2 常驻恢复凭据应只有读权限。密钥由 `keygen` 生成，macmini2 和独立受保护位置各留一份；**不能只放在 VPS，也不能把解密钥匙的唯一副本锁在加密包内**。更换密钥必须保留旧包对应的钥匙。恢复包必须使用独立私有桶，并设置独立保留策略，不能继承业务对象的 45 天删除策略。

2026-09-18 首次验证使用现有桶的 `recovery-v1/` 隔离前缀，内容已加密。现有 Cloudflare token 对桶管理返回 403，无法确认公开访问/生命周期或创建独立私有桶、只读凭据；这些仍待补齐，不能声称已具备最小权限的最终部署。

清单也放仓库外（0600）：

```json
{
  "metadata": {
    "deployment": "paid",
    "publicCommit": "FULL_40_CHARACTER_COMMIT",
    "privateCommit": "FULL_40_CHARACTER_COMMIT_OR_NULL",
    "image": "sha256:VERIFIED_RUNNING_IMAGE_ID",
    "postgresMajor": 17
  },
  "files": [
    { "name": "database.dump", "source": "/protected/snapshot.dump" },
    { "name": "config/app.env", "source": "/protected/app.env" }
  ]
}
```

实际清单还应包含 migrate.env、operator/channels 配置、会话/加密密钥、必要的基础设施角色配置和两端各自 Tunnel 的配置。`APP_IMAGE` 旧 env 字面值可能过时，以正在运行容器的 image ID 和 APP_VERSION 为准。打包不能在部署中途进行；检查前后版本一致。

```sh
bun scripts/recovery-bundle.ts keygen /protected/recovery.key
bun scripts/recovery-bundle.ts publish /protected/bootstrap.json /protected/inventory.json /protected/receipt.json
bun scripts/recovery-bundle.ts list /protected/bootstrap.json
bun scripts/recovery-bundle.ts fetch /protected/bootstrap.json recovery-v1/paid/SELECTED.sealed /protected/new-restore
sh scripts/restore-recovery-db.sh /protected/new-restore aip-recovery-check-UNIQUE
```

配置变更、密钥轮换和每次发布后都必须重建恢复包。当前包是显式快照；小时级 PG dump 不等于每小时自动更新配置包。**自动发布钩子及配置与最新 dump 的配套校验尚待接入**，不能把旧包的镜像/schema 与任意新 dump 随意拼接。

## 接管流程和数据边界

1. 选最后一个已完成、可解密且版本配套的包，记录快照时间和 RPO。先隔离恢复，再迁移到目标版本 schema；迁移失败不接流量。
2. 校验账号、会话、完整对话、画布云目录、任务状态和 R2 对象读取。保留网页及 API 原域名、原签名密钥、Cookie 设置。快照之后才创建的会话不保证存在，不能承诺所有用户无感。
3. 新实例使用生产对应 R2 bucket/prefix，耐久对象保持 `durable/<deployment-prefix>`。恢复前禁止孤儿文件清理，旧快照缺引用不等于文件可删除。**新备用禁止 MinIO**；旧事故卷保留到文件逐项核验迁移完成。
4. 切换前必须建立单写者。旧机器能访问时先停止接新写入、排空执行器，再停止其 BFF/worker。旧机器不可达时需要独立控制面的短租约，在 BFF 和 worker 启动及运行期间校验，失约必须拒写/停执行；仅改 DNS 或健康检查不是防双写。
5. 固定 `api.muvloom.online`、`api.nainma.online`、`image-api.qiliangjia.one`，在 Cloudflare 把 CNAME 指向目标独立 Tunnel。两端 ingress 都预配原 Host；backup-api 只用于验收。Pages 不重发，已打开页面仍请求同一 API。既有 SSE 连接需要断开重连，不能承诺 DNS 修改会迁移在途连接。
6. 结果未知的任务保留上游 task ID，仅轮询已有任务；不得重提或重新扣费。无上游 ID 的未知结果需人工核对。

## 切回流程

恢复机器健康不自动触发回切。先比较 VPS 原库与恢复快照之间的增量，处理快照后、宕机前的记录；只拿 macmini2 全库覆盖 VPS 可能丢失这段数据。

完成差异核对后：停止 macmini2 新写入 → 排空在途任务 → 最终备份 → 恢复至 VPS 新库 → schema/业务/文件校验 → 转移写权限 → 切原 API 的 Tunnel 路由。保留原库、最终包及差异清单，核验账本不重复、承接期间对话可读，再结束应急状态。

短租约控制面、原域名切换命令、后端 epoch 刷新前端缓存、发布包异地归档、外部备份告警及增量核对工具仍是后续实施项。当前恢复工具**不自动切 DNS，不实现自动主备切换**。

## 首次恢复验证

2026-09-18 在 macmini2 使用独立 bootstrap 从 R2 下载付费/内部加密包，均完成 PG 17 隔离恢复；没有从 VPS 向 macmini2 传 dump。付费快照包含 7 用户、16 会话、12 对话、207 消息和 326 任务。计数是该快照的验收数据，不是持续状态。

受保护操作目录：两端 `~/.config/ai-image-playground/recovery/cold-20260918/`。macmini2 的 `paid-restored/restore-counts.txt` 和 `internal-restored/restore-counts.txt` 为结果；`aip-recovery-check-*-20260918` 是停止的隔离验证容器，不能当作正在承接的服务。
