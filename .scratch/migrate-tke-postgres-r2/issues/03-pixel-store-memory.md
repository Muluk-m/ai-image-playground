# 03 — 像素对象经 Pixel store（内存 adapter）

**What to build:** 带参考图的队列任务能跑完，访客用原来的 `GET .../image/{index}` 拿到输出字节。像素对象不再进任务库。对象存储失败时仍是「完成但没图」。输入不再转 WebP。

**Blocked by:** 02 — 队列元数据上 Postgres

**Status:** ready-for-agent

- [ ] 带输入图的 submit 能完成，输出图可按 index 拉取，content-type 正确
- [ ] worker 跑任务前能从 Pixel store 还原输入图再交给上游
- [ ] 缺对象时 image 端点 404；写对象失败时任务可 completed 且无图
- [ ] 任务元信息里没有图像字节列
- [ ] Queue HTTP 路径不变；测试 Pixel store 用内存 adapter
