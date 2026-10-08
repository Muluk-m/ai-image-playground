# 0021：服务运行日志走 Docker 的 fluentd 日志驱动，由每套部署自带的 Fluent Bit 交给 BFF 入库

日期：2026-10-08。状态：已接受。关联：ADR 0018，docs/deploy/server-logs.md。

运维要在 Admin 里按级别、服务、时间检索所有容器的运行日志，而不只是 BFF 和 worker 自己写进数据库的那部分。Docker 的 json-file 本来就记着每个容器的输出，但发布脚本每次都删掉旧的执行器容器，日志跟着消失；Admin 也读不到它，ADR 0018 定过不挂 Docker socket。

我们让 Docker 把每个容器的输出用 `fluentd` 日志驱动、异步地发到本部署的一个 Fluent Bit 容器；它监听一个放在宿主机目录里的 Unix socket（Docker 守护进程从宿主机拨它，所以不占宿主机端口，三套部署也不会撞），把记录批量 POST 给 BFF 的内部接口，由 BFF 解析、脱敏后写进 `server_logs`。Fluent Bit 把没送达的批次缓冲在磁盘上并无限重试，BFF 写库失败就回 503，所以 BFF 或数据库重启只会让日志晚到。应用里原先直接把 pino 日志写库的那条路随之拿掉，日志只经 stdout 一条路，不再有两份。

放弃了两条路。一是让采集容器只读挂载 `/var/lib/docker/containers`：能从断点续读，但那里还放着每个容器的 `config.v2.json`，里面是三套部署的数据库密码和上游 API key，违背 ADR 0018 里采集容器不碰凭证的原则。二是 Loki 加 Grafana：要多几百 MB 内存（宿主机只有 3.6 GB），而且是另一套界面和登录，运维要的是 Admin 里的一页。

代价：采集容器停机期间，运行中的容器只在内存里暂存，一次性的短命容器（迁移）可能丢掉那段输出；`docker logs` 依赖 Docker 的本地双写缓存，不再是 json-file 原件。纯文本日志的级别靠关键词推断，不保证准确。共享的 PostgreSQL 属于基础设施栈，暂不接入。
