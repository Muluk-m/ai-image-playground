# 04 — Admin 只读 Postgres 并反代出图

**What to build:** 运维面板连同一份任务库：能按设备聚合、打开任务详情、看到输出图。登录仍用 cookie。面板写不进队列任务或日配额。图走集群内 BFF 反代，不把 R2 暴露给浏览器。

**Blocked by:** 03 — 像素对象经 Pixel store（内存 adapter）

**Status:** done

- [x] 设备列表与任务详情的数字语义与迁库前一致（含今日配额）
- [x] 已完成任务的图能在面板里打开
- [x] 只读连接下插入/更新队列任务会失败
- [x] 面板拉图打 BFF 内部 image 端点，不出现公开对象 URL
