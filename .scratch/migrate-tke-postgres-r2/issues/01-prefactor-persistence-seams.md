# 01 — Prefactor：异步 Task store + Pixel store 缝

**What to build:** 队列任务和像素对象改走两条明确的缝进出。产品行为与现在完全一样：submit / 轮询 / 出图 / 取消 / 配额仍通过 Queue HTTP 工作。sqlite 暂时还在缝后面，调用方不再直接碰同步 sqlite API。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] Queue HTTP 现有场景（submit、幂等、配额、出图、取消、claim、重启 interrupted）全部仍绿
- [ ] 任务元数据只通过 Task store 读写；像素对象只通过 Pixel store 读写
- [ ] Task store 与 Pixel store 的接口是异步的；测试仍可注入当前 sqlite adapter
- [ ] 浏览器契约不变：同一组路径和状态码
