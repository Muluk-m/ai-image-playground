# 07 — TKE 验证环境 + 切 DNS 手册

**What to build:** 新 hostname 上三条工作负载能完整生图（空 Postgres、R2 前缀、单 worker）。验证通过后，抽干旧 Mac mini 队列，再把 `image.nainma.online` 指到 TKE。Cloudflare 仍在前面。人类步骤（密钥、桶生命周期、Ingress/DNS）用向导，不写进应用。

**Blocked by:** 06 — 三进程镜像可启动

**Status:** ready-for-human

- [ ] 验证域名上：内置模型 submit → 完成 → 拉图成功
- [ ] TKE 与 Postgres、R2、上游网络可达；不再依赖 macmini localhost 网关
- [ ] 切正式 DNS 前旧 worker 队列已抽干；新旧不同时写一份库
- [ ] 回滚口径写明：未双写的前提下可将 DNS 指回 macmini
- [ ] 源站 idle 超时仍大于入口 keep-alive，避免切 CLB 后偶发 502
- [ ] `/wizard` 覆盖：R2 前缀生命周期、集群 Secret、验证域名、正式 DNS 切换
