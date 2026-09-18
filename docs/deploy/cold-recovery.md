# R2 冷恢复

生产保持 Pages + VPS；macmini2 按需从 R2 恢复，不定时同步备用 PG。

## 实施状态

| 项目 | 状态 |
| --- | --- |
| PG 备份 | 每小时上传唯一 dump，最后上传 SHA-256 完成标记；超过两小时无成功备份则健康失败 |
| 配置恢复包 | 显式清单包含 PG dump、应用/迁移/operator/Tunnel 配置、提交和镜像 ID；AES-256-GCM 加密，上传后回读校验 |
| 恢复演练 | 内部版、付费版均已在 macmini2 从 R2 下载并完成 PG 17 隔离恢复 |
| 独立私有桶、只读恢复凭据 | 未完成；现有 Cloudflare 管理凭据返回 403。当前使用业务桶的 `recovery-v1/` 加密前缀 |
| 固定域名切换、跨机器单写者保护 | 未实现 |
| 自动刷新恢复包、镜像异地归档、外部告警、增量核对工具、前端后端代次刷新 | 未实现 |

小时级 PG 备份不等于恢复包自动刷新。每次发布、配置变更或密钥轮换后须重新打包，数据库、schema、配置和镜像版本必须配套。镜像层须另存完整发布包及 `SHA256SUMS`；镜像 ID 本身不能恢复镜像。

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
    "privateCommit": null,
    "image": "sha256:VERIFIED_IMAGE_ID",
    "postgresMajor": 17
  },
  "files": [
    { "name": "database.dump", "source": "/protected/snapshot.dump" },
    { "name": "config/app.env", "source": "/protected/app.env" }
  ]
}
```

付费部署的 `privateCommit` 必须填写实际提交。以运行容器的镜像 ID、`APP_VERSION` 为准；打包前后核对版本未变化。当前打包器输入上限 64 MiB，超过时须升级流式方案，不得截断。

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

操作记录位于两端 `~/.config/ai-image-playground/recovery/cold-20260918/STATUS.md`；最新演练目录为 macmini2 的 `{paid,internal}-restored-4436509c/`。

## 接管与切回要求

以下为待实现流程，当前工具不自动切换流量。

1. 选择完成且版本配套的包，记录快照时间；隔离恢复、迁移并核对账号、会话、对话、任务和 R2 对象。
2. 保持原网页/API 域名、Cookie、签名密钥和账号命名空间。快照之后新增的会话可能需要重新登录。新实例使用生产 R2 前缀；核对引用前禁用孤儿文件清理。
3. 切换前确保单写者：旧主可达则拒绝新写入并排空；不可达则必须由独立控制面的短租约约束两端 BFF/worker。仅改 DNS 或同库任务租约不能防跨库双写。
4. 在 Cloudflare 将原 API 指向目标独立 Tunnel，两端预配原 Host；Pages 无需重发，既有 SSE 需重连。入口为 `api.muvloom.online`、`api.nainma.online`、`image-api.qiliangjia.one`。
5. 未知结果任务保留上游 ID，仅查询已有任务，不重提或重复扣费；无上游 ID 时人工核对。
6. 原主恢复后不自动回切。先核对原主快照后的记录与备用承接增量，再停止备用新写入、排空、最终备份、恢复到 VPS 新库、验证、转移写权限、切入口。保留两份源库和差异清单，禁止直接覆盖或重复结算。
