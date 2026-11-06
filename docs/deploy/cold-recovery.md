# 灾备手册

当前生产是一个 muvloom Pages 项目与共享 VPS 后端（目标 `paid`），企业网页/API 域名共用它；`test` 使用独立数据资源。macmini2 按需从 R2 恢复生产，不定时同步备用 PG。保留现存 `PAID_*`、`image-playground-paid` 及 R2 前缀，不通过改名创建替代生产资源。

## 实施状态

| 项目 | 状态 |
| --- | --- |
| PG 备份 | 每小时上传唯一 dump，最后上传 SHA-256 完成标记；新一组上传成功后删除旧 dump，只保留最新一组；容器启动时，成功列举后若完成标记缺失、已超过半小时或时间在未来，会尝试补跑；列举失败或补跑执行失败仍可能留下备份缺口，不保证补回发布期间的整点备份；超过两个半小时无成功备份则健康失败 |
| 配置恢复包 | 显式清单包含 PG dump、应用/迁移/operator/Tunnel 配置、提交和镜像 ID；AES-256-GCM 加密，上传后回读校验 |
| 历史恢复演练（2026-09-18） | 当时的 qlj、muvloom 均在 macmini2 从 R2 下载并完成 PG 17 隔离恢复；不代表当前版本、共享后端或流量接管已经验证 |
| 独立私有桶、只读恢复凭据 | 未完成；现有 Cloudflare 管理凭据返回 403。当前使用业务桶的 `recovery-v1/` 加密前缀 |
| 固定域名切换、跨机器单写者保护 | 未实现 |
| 自动刷新恢复包、镜像异地归档、外部告警、增量核对工具、前端后端代次刷新 | 未实现 |

单副本 PG 备份只提供最新状态，不提供历史恢复点；最后一份损坏或备份前数据已经出错时，没有上一版可回退。小时级 PG 备份不等于恢复包自动刷新。每次发布、配置变更或密钥轮换后须重新打包，数据库、schema、配置和镜像版本必须配套。镜像层须另存完整发布包及 `SHA256SUMS`；镜像 ID 本身不能恢复镜像。当前生产恢复清单只针对共享 `paid` 后端；测试备份与恢复清单独立，历史旧部署包不作为当前企业域名的独立恢复目标。

## 凭据与清单

bootstrap、清单及密钥保存在仓库外，目录 0700、文件 0600。上传使用写凭据，恢复应使用只读凭据；解密密钥在 macmini2 和独立受保护位置各留一份，轮换后保留旧钥匙。最终恢复桶须私有且配置独立保留策略，不继承业务文件过期规则。

bootstrap 格式：

```json
{
  "endpoint": "https://ACCOUNT.r2.cloudflarestorage.com",
  "bucket": "PRIVATE_RECOVERY_BUCKET",
  "accessKeyId": "ACCESS_KEY_ID",
  "secretAccessKey": "SECRET",
  "prefix": "recovery-v1/paid/",
  "keyFile": "/protected/recovery.key"
}
```

清单格式（实际须列全应用、迁移、operator、会话密钥及 Tunnel 配置）：

```json
{
  "metadata": {
    "deployment": "paid",
    "publicCommit": "FULL_40_CHARACTER_COMMIT",
    "privateCommit": "FULL_40_CHARACTER_OVERLAY_COMMIT",
    "image": "sha256:VERIFIED_IMAGE_ID",
    "postgresMajor": 17
  },
  "files": [
    { "name": "database.dump", "source": "/protected/snapshot.dump" },
    { "name": "config/app.env", "source": "/protected/app.env" }
  ]
}
```

muvloom 生产包的 `privateCommit` 必须填写实际 overlay 提交，并与发布使用的 `private.lock` 配套。以运行容器的镜像 ID、`APP_VERSION` 为准；打包前后核对版本未变化。当前打包器输入上限 64 MiB，超过时须升级流式方案，不得截断。

## 打包与验证

```sh
# 仅首次生成；不要覆盖现有密钥
bun scripts/recovery-bundle.ts keygen /protected/recovery.key
bun scripts/recovery-bundle.ts publish /protected/bootstrap.json /protected/inventory.json /protected/receipt.json
bun scripts/recovery-bundle.ts list /protected/bootstrap.json
bun scripts/recovery-bundle.ts fetch /protected/bootstrap.json recovery-v1/paid/SELECTED.sealed /protected/new-restore
# 在 macmini2 执行；目标名称必须未使用
sh scripts/restore-recovery-db.sh /protected/new-restore aip-recovery-check-UNIQUE
```

`fetch` 校验完成标记、完整性及解密结果，只写入新目录。恢复脚本创建无网络、无端口的 PG 17，单事务导入并输出 `restore-counts.txt`，随后停止并保留容器/卷；不启动 BFF 或 worker。

2026-09-18 历史操作记录位于两端 `~/.config/ai-image-playground/recovery/cold-20260918/STATUS.md`；当时的 macmini2 演练目录为 `{paid,internal}-restored-4436509c/`。这些目录名仅用于查找历史证据，当前恢复须使用版本配套的新生产包。

## 接管与切回要求

以下为待实现流程，当前工具不自动切换流量。

1. 选择共享 muvloom 生产（`paid`）已完成且版本配套的包，记录快照时间；隔离恢复、迁移并核对账号、会话、对话、任务和 R2 对象。准备当前固定 receiver/runtime，遵循[部署手册的仓库外前提](image-release.md#仓库外更新前提)，不执行历史包内的旧脚本或退役目标。
2. 保持原网页/API 域名、Cookie、签名密钥和账号命名空间。快照之后新增的会话可能需要重新登录。新实例使用生产 R2 前缀；核对引用前禁用孤儿文件清理。
3. 切换前确保单写者：旧主可达则拒绝新写入并排空；不可达则必须由独立控制面的短租约约束两端 BFF/worker。仅改 DNS 或同库任务租约不能防跨库双写。
4. 在 Cloudflare 将原 API 指向目标独立 Tunnel，两端预配原 Host；Pages 无需重发，既有 SSE 需重连。`api.muvloom.online`、`api.nainma.online`、`image-api.qiliangjia.one` 均须路由到恢复后的同一个生产后端。保留企业第一方 API 别名与按 origin 的 SSO 策略。若需重发 Pages，仓库外配置必须使用 `ENTERPRISE_PUBLIC_ORIGIN` / `ENTERPRISE_BFF_BASE_URL`，见[部署手册](image-release.md)。
5. 未知结果任务保留上游 ID，仅查询已有任务，不重提或重复扣费；无上游 ID 时人工核对。
6. 原主恢复后不自动回切。先核对原主快照后的记录与备用承接增量，再停止备用新写入、排空、最终备份、恢复到 VPS 新库、验证、转移写权限、切入口。保留两份源库和差异清单，禁止直接覆盖或重复结算。

## 附录：旧备用服务

状态：2026-09-18 已休眠。BFF、worker、PostgreSQL、MinIO 均停止，Tunnel LaunchAgent 已禁用；镜像、配置及数据卷保留。生产运行在 VPS。

### 配置位置

| 项目 | 值 |
| --- | --- |
| 主机 / 目录 | `macmini2` / `/Users/mac/services/aip-free-recovery-20260918` |
| Compose | `compose.json`，project `aip-free-recovery` |
| 本机 / 外部 API | `127.0.0.1:38377` / `backup-api.muvloom.online` |
| PostgreSQL | PG 17，库 `aip_recovery`，卷 `aip-free-recovery_postgres` |
| 对象存储 | R2 `ai-images`，前缀 `recovery-legacy-20260918/` |
| 原 MinIO 卷 | `aip-free-recovery_objects`，仅留作回滚 |
| Tunnel | `~/Library/LaunchAgents/com.muvloom.recovery-tunnel.plist` |
| 历史镜像 | `aip-free-recovery:15f67181` |

凭据在服务目录的 `app.env`、`operator-config.json`、`channels.json` 和 Tunnel 配置中，不提交仓库。该旧环境使用匿名免费模式，不具备生产账号、积分和云同步能力；正式接管须按[冷恢复手册](cold-recovery.md)恢复最新生产快照。

### 历史环境不用于当前接管

上述旧匿名服务已退役，保留配置、镜像、卷和停机快照仅供历史审计；不按旧项目示例重新启动它或切换生产域名。当前接管必须恢复共享 muvloom 后端的最新配套生产包，并完成单写者、账号、计费、云同步及全部 API 别名验收。现有文档没有这套流程已完成的线上证据。

禁止 `down -v` 或删除历史卷；历史数据归并仍须按下节审计记录核对归属。

### 数据与审计

- 原承接期 10 条任务及关联对话、产物已回填。停机时旧库共 16 条任务（14 完成、2 失败）；另外 6 条在切回界定时间之后，尚未在本次操作中归并，禁止重复或未经归属核对导入。
- 停机快照：服务目录 `shutdown-20260918/`；工作站副本：`~/.config/ai-image-playground/recovery/cold-20260918/legacy-shutdown-20260918/`。
- 原 14 个 MinIO 对象已迁 R2 并逐个验 SHA-256。原配置保留为 `*.before-r2-20260918`。
- 回填审计：工作站 `~/.config/ai-image-playground/recovery/20260918/import-to-vps/`，VPS `/home/ubuntu/backups/recovery-import-20260918/`。
- 浏览器画布、缓存产物和草稿在原站点 IndexedDB；完整对话在对应 PG，本地画布不等于对话备份。

事故期间曾通过 `switch-pages.sh` 改 API 配置。该方式只影响新加载页面，旧页面仍可能向备用写入；不作为后续灾备切换入口。
