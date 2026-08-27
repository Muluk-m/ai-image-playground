# Migrate queue backend to TKE (Postgres + R2)

**Status:** ready-for-agent

## Problem Statement

生图工作台的服务端现在绑在一台 Mac mini 上：BFF、worker、admin 三个进程共用一份本地 SQLite，像素对象也塞在库里。这套装不进 TKE——文件库不能给三个进程安全地共享写，更不能水平扩展。运维希望服务端跑在已有 TKE 和 Postgres 集群上，像素走已有 Cloudflare R2 桶，用新域名验证后再切正式 DNS。浏览器里的历史、BYOK、队列 HTTP 契约不能断。

## Solution

把队列任务和日配额放到现有 Postgres；把像素对象放到 R2 桶 `ai-images` 的专用前缀下，7 天后自动过期。BFF / worker / admin 作为三个 TKE 工作负载部署，静态前端仍由 BFF 托管。新环境空库起步，不导旧 SQLite。先在独立 hostname 上验证，再把 `image.nainma.online` 指过去。Cloudflare 继续做入口。Worker 第一期仍是单副本。用户侧协议不变：短请求 submit / poll / 拉图，刷新仍能恢复进行中的队列任务。

## User Stories

1. As a 访客, I want 打开正式站点仍然能用内置模型生图, so that 迁集群不会变成一次产品中断
2. As a 访客, I want 提交后很快拿到 request_id, so that 页面不必卡在一次长达数分钟的上游调用上
3. As a 访客, I want 轮询任务状态直到完成或失败, so that 我知道图好了没有
4. As a 访客, I want 完成后按 index 拉取像素对象, so that 图能进画布和本地历史
5. As a 访客, I want 带参考图或 mask 提交, so that 图生图和工作台编辑仍可用
6. As a 访客, I want 一次请求出多张（n>1）, so that 变体流程不丢
7. As a 访客, I want 刷新页面后进行中的队列任务自动接着轮询, so that 长任务不怕误关标签
8. As a 访客, I want 同一 client_request_id 再提交返回同一任务, so that 刷新窗口不重复扣上游额度
9. As a 访客, I want 取消进行中的任务, so that 我不想等的图可以停
10. As a 访客, I want 日配额用尽时看到明确拒绝和重置时间, so that 我知道不是模型坏了
11. As a 访客, I want 配额按设备、按 UTC 日计算且上限仍是 80, so that 迁库后限额口径不变
12. As a 访客, I want 模型下拉仍来自内置 channel 列表, so that 我不必填 key 也能选模型
13. As a 访客, I want BYOK 配置继续只存在浏览器并直连我填的地址, so that 迁 BFF 不影响自带 key 的人
14. As a 访客, I want 本地 IndexedDB 历史在切 DNS 后还在, so that 我的作品不跟服务端库一起被清空
15. As a 访客, I want 灵感库和 PWA 安装仍可用, so that 静态资源跟着新部署走
16. As a 访客, I want 新验证域名上也能完整生图, so that 正式域名切换前我（或运维）能先试用
17. As a 访客, I want 失败任务看到可理解的错误类型, so that 我能决定重试还是改提示词
18. As a 访客, I want 上游结果不明（中断/超时）时任务停在失败而不是偷偷再打一次上游, so that 不会被重复扣费
19. As an admin 使用者, I want 用密码登录运维面板, so that 只有我能看队列
20. As an admin 使用者, I want 按设备聚合查看近期任务量, so that 我能发现异常用量
21. As an admin 使用者, I want 打开一条任务详情, so that 我能看模型、状态、错误和上游诊断
22. As an admin 使用者, I want 看任务的输出图, so that 排障时能对上用户看到的图
23. As an admin 使用者, I want 只读任务库, so that 面板误操作写不坏队列
24. As an admin 使用者, I want 图从集群内 BFF 反代出来, so that 面板不必公开 R2
25. As an admin 使用者, I want 像素过期后详情仍有任务元信息, so that 七天后还能查谁在何时跑过什么模型
26. As a 运维, I want BFF、worker、admin 分别作为 TKE 工作负载, so that 重启 API 不会杀掉正在跑的上游调用
27. As a 运维, I want worker 第一期只有一个副本, so that 行为与现网单 worker 一致、没有重复 claim
28. As a 运维, I want 三个进程连同一份 Postgres, so that 入队、执行、只读查询看到同一份队列任务
29. As a 运维, I want 像素对象进 R2 而不是 Postgres, so that 共享 PG 集群的 WAL 和备份不被图打满
30. As a 运维, I want 对象 key 带前缀 `image-playground/`, so that 生命周期规则伤不到桶里其它资产
31. As a 运维, I want 该前缀 7 天后自动删除对象, so that 短生命周期不用靠应用定时扫桶
32. As a 运维, I want 禁止给整个 `ai-images` 桶套过期规则, so that 共用桶不会被这次迁移清空
33. As a 运维, I want R2 桶保持私有, so that 猜到 URL 也不能列出或匿名下载全部图
34. As a 运维, I want BFF 继续代理 `.../image/{index}`, so that 前端和 admin 都不用改拉图地址
35. As a 运维, I want 上游密钥只在集群 Secret 里, so that 浏览器永远拿不到内置 channel 的 key
36. As a 运维, I want channels 配置可注入而不把真 key 写进镜像, so that 发版和轮换密钥分开
37. As a 运维, I want 启动时缺某个 channel 密钥只告警不让整进程自杀, so that 一个模型没配 key 不会拖垮站点
38. As a 运维, I want CORS 收成正式站点 origin, so that 任意网页不能拿 BFF 去烧额度
39. As a 运维, I want `/health` 给探针用, so that 平台能重启死掉的副本
40. As a 运维, I want 健康检查不要因为「正在跑一张 15 分钟的图」把 worker 判死, so that 长任务不会被探针杀掉
41. As a 运维, I want SIGTERM 后至少有约 60 秒退出窗口, so that worker 能标中断而不是被直接 SIGKILL
42. As a 运维, I want worker 重启时把残留的 in_progress 标成 interrupted 且不自动重打上游, so that 滚动发布不会重复扣费
43. As a 运维, I want 迁移 DDL 不会被 BFF 和 worker 同时跑坏, so that 首次上线不会卡在抢锁
44. As a 运维, I want 新环境空库, so that 不必写 sqlite 导 PG 的一次性脚本
45. As a 运维, I want 切正式 DNS 前把旧 worker 队列抽干, so that 用户手里的旧 request_id 不会在新 BFF 上 404
46. As a 运维, I want 新旧环境不要同时写同一份库, so that 不会出现双主
47. As a 运维, I want Cloudflare 继续在 `image.nainma.online` 前面, so that 现有橙云和证书策略还能用
48. As a 运维, I want 源站空闲超时仍大于入口 keep-alive, so that 切 CLB 后不会再出现偶发 502
49. As a 运维, I want 镜像能分别启动 BFF、worker、admin, so that 现有「只打 BFF」的镜像不够用时有明确产物
50. As a 运维, I want 静态前端由 BFF 同源托管, so that 第一期不必再拆一套 CDN 契约
51. As a 运维, I want `runtime-config` 在新环境打开 BFF, so that 内置模型会出现在下拉框
52. As a 运维, I want TKE 能直连 PG 所在网络, so that Pod 起得来
53. As a 运维, I want TKE 能出网访问 R2 和各上游, so that worker 能存图、能生图
54. As a 运维, I want 上游从集群直连各 channel（或一个集群能访问的网关）, so that 不再依赖 macmini 的 localhost 网关
55. As a 运维, I want 切 DNS 失败时还能把流量指回 macmini, so that 有回滚窗口（前提是没让两边写同一份库）
56. As a 开发, I want 任务库访问是异步的, so that 驱动从 sqlite 同步 API 换成 PG 后调用方口径一致
57. As a 开发, I want Task store 和 Pixel store 是两条缝, so that 测队列不必连真 R2，测出图不必连真 PG
58. As a 开发, I want 现有队列路由测试仍作为最高行为缝, so that 迁存储不改产品契约
59. As a 开发, I want admin 设备聚合在 PG 上结果与现在同语义, so that 面板数字不漂
60. As a 开发, I want 配额扣减和建任务在同一事务, so that 失败的 submit 不会白扣次数
61. As a 开发, I want 写完像素对象再把任务标完成, so that 用户看到 completed 时图一定能拉到（拉失败则走「完成但没图」的既有降级）
62. As a 开发, I want 终态后不必再把输入转 WebP, so that R2 短过期已经解决体积问题
63. As a 开发, I want 本地测试不碰真实 TKE / 真实 R2 / 生产 PG, so that CI 和笔记本都能绿
64. As OpenAI-compatible 流量, I want 默认同时只有 1 个上游调用, so that 慢编辑不会打爆上游
65. As Gemini 流量, I want 默认同时最多 2 个上游调用, so that 快模型不必排在慢编辑后面
66. As 进行中的任务, I want cancel 把库状态改掉后 worker 能观察到并中止 fetch, so that 跨进程取消仍然有效

## Implementation Decisions

- 部署目标是 TKE。三个进程：BFF（短 HTTP + 静态前端）、worker（调上游）、admin（HMAC cookie 登录、只读）。第一期各 1 副本，worker 明确 `replicas=1`。
- 队列任务、日配额、任务元信息进现有 Postgres 集群。像素对象不进 PG。ADR：`docs/adr/0001-postgres-queue-r2-pixels.md`。
- 像素对象进 Cloudflare R2 桶 `ai-images`（账号面板路径已确认）。Key 形态：`image-playground/{taskId}/input/{idx}` 与 `image-playground/{taskId}/output/{idx}`。生命周期 7 天，**只匹配该前缀**。桶保持私有。
- 浏览器和 admin 拉图仍走既有 Queue HTTP：`GET /v1/queue/requests/{id}/image/{index}`。BFF 从 Pixel store 读字节再返回。第一期不做签名 URL 跳转。
- Queue HTTP 其余契约不变：submit 立即返回 queued；status 可轮询；result 在 completed 时给元信息、未就绪 425；cancel 只改库状态。幂等键、device_id、配额上限 80、错误类型（含 interrupted / upstream_result_unknown）保持。
- Task store 模块承接：插入 queued、幂等查找、配额 UPSERT、原子 claim（`queued` → `in_progress`）、终态更新带原状态谓词、重试回 queued + next_retry_at、admin 聚合与详情。生产 adapter 是 Postgres。接口是异步的。
- Pixel store 模块承接：按 taskId + kind + idx 写入/读取字节。生产 adapter 是 R2。submit 在同一任务事务成功落库后（或等价：先有 task 行再写对象；对象孤儿靠 7 天过期回收）写入输入像素。worker 跑任务前从 Pixel store 还原输入。完成时先写输出像素，再把任务标 completed；对象存储失败则沿用「完成但没图」降级。
- Postgres schema 语义对齐现表：tasks（含 client_request_id 部分唯一、attempt_count、next_retry_at、upstream 诊断字段）、daily_quota 复合主键、不再把图像字节放在 blob 列。device_id 从 request JSON 抽出，供 admin 聚合（生成列或等价索引），避免回表扫胖 JSON。时间戳继续用毫秒整数。payload 用 JSON/JSONB。
- 迁移由单一互斥步骤执行（advisory lock 或 init 容器），禁止 BFF 与 worker 无锁双跑 DDL。
- admin 用只读角色或只读事务连同一 Postgres。图片仍反代 BFF 集群内地址，不直连 R2。
- 启动恢复：worker 把残留 in_progress 标 failed / interrupted，不自动重提交。优雅退出硬上限仍约 55s，进程管理器至少给 60s。
- 应用层定时清像素字节不再作为正确性依赖；R2 生命周期是过期的权威。任务元信息仍可按既有 30 天策略清理。输入转 WebP 归档取消。
- 新环境空库。不导 macmini SQLite。切正式 DNS 前抽干旧队列；新旧不得双写。验证 hostname 默认 `image-k8s.nainma.online`（若运维另有名字，只改 DNS 配置，不改代码契约）。Cloudflare 继续在正式域名前面。
- 上游：TKE 不访问 macmini localhost 网关。直连各 channel 的 baseUrl，或一个集群可达的网关地址。channel 密钥来自环境/Secret，secretRef 约定不变。
- 源站 HTTP idle 超时保持大于入口 keep-alive（现口径 255s），避免切 CLB 后复现偶发 502。
- 前端、BYOK、灵感库、PWA、日配额数字、worker 每 provider 并发默认值，本期不改。
- 本地与测试不使用 sqlite 文件作为 Task store 生产路径。`DATABASE_URL` 对运行中的 BFF/worker/admin 是 Postgres 连接串。

## Testing Decisions

好测试只锁外部行为：给定一次 submit，状态怎么走、图怎么被拉到、配额怎么拒绝、幂等怎么复用、取消怎么停、重启怎么把 in_progress 变成 interrupted。不锁 SQL 文本、不锁 R2 SDK 调用形状、不锁 k8s YAML 排版。

测试缝（已确认，越少越好）：

1. **Queue HTTP**（已有、最高缝）：submit / status / result / image / cancel。行为测试打这条缝，注入 Task store 与 Pixel store 的测试 adapter。
2. **Task store**：生产 adapter = Postgres；测试 adapter = PGlite（或一次性测试库）。覆盖 claim 原子性、配额与建任务同事务、幂等、admin 聚合语义、迁移可重复执行。
3. **Pixel store**：生产 adapter = R2；测试 adapter = 内存。覆盖按 taskId/kind/idx 读写、缺对象时 image 端点 404、「完成但没图」降级。不为 TKE/Ingress 单开缝。

测哪些模块：队列路由、配额、任务调度/恢复、出图代理、admin 只读查询与反代图、Task store 迁移。不在单测里打真 TKE、真 R2、生产 PG。

仓库里已有的对标：BFF 路由集成（含出图二进制）、配额 UPSERT、blob 外置与完成事务、worker 调度与并发、启动 recovery、admin 设备聚合和任务列表、idle 超时不变量。迁存储后这些测试应改打新 adapter，而不是删掉场景。

## Out of Scope

- 多 worker / `FOR UPDATE SKIP LOCKED` / Redis 队列
- 把 sqlite 历史或像素 ETL 进 PG/R2
- 像素进 Postgres bytea，或改用 COS
- 新建 R2 桶；整桶生命周期
- 改浏览器协议、改 IndexedDB、改 BYOK
- 签名 URL 直出 R2（可后续）
- 把静态站拆到独立 CDN
- 改日配额上限、改默认并发数字、改上游重试分类
- 给 BFF 加应用层鉴权
- 下线 macmini 的代码删除（切 DNS 并验证之后另做）
- fleet launchd 契约改造成 k8s 控制器（本期交付 TKE 可运行的镜像与清单即可）

## Further Notes

- 词汇用 `CONTEXT.md`：队列任务、像素对象、日配额。不要把浏览器历史叫成任务。
- 运维前提（本 spec 不在应用里实现，切流量前必须为真）：TKE 与 PG 同网络可达；TKE 能出网到 R2 与上游；R2 上已有前缀生命周期规则且不是整桶过期；验证域名 DNS/Ingress 已建。
- 人类才能做的步骤（令牌、桶规则、集群密钥、切 DNS）走 `/wizard`，不要写进应用代码。
- 下一技能：`/to-tickets`，把本 spec 拆成带阻塞边的 tracer-bullet 票，仍放在 `.scratch/migrate-tke-postgres-r2/issues/`。
