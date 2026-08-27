# 06 — 三进程镜像可启动

**What to build:** 运维能用镜像分别拉起 BFF、worker、admin。BFF 托管静态前端并提供 Queue HTTP；worker 消化队列任务；admin 提供只读面板。三者共用 Postgres 与 R2 配置，worker 副本语义仍是一个。

**Blocked by:** 04 — Admin 只读 Postgres 并反代出图; 05 — R2 生产 adapter

**Status:** ready-for-agent

- [ ] 同一构建产物能以三种命令/入口启动三个进程
- [ ] BFF 健康检查可用；worker 长任务进行中时探针不得把进程判死
- [ ] 停止信号后进程管理器至少有约 60 秒让 worker 退出
- [ ] 静态前端由 BFF 同源托管；runtime-config 可打开 BFF
- [ ] 密钥和连接串来自环境，不进镜像层
