# 05 — R2 生产 adapter

**What to build:** 生产环境的像素对象落到已有 R2 桶 `ai-images`，key 带前缀 `image-playground/`。前端和 admin 仍走 BFF 代理拉图，桶保持私有。过期靠该前缀上 7 天生命周期，不给整桶套规则。

**Blocked by:** 03 — 像素对象经 Pixel store（内存 adapter）

**Status:** done

- [x] 生产 Pixel store adapter 按 `image-playground/{taskId}/input|output/{idx}` 读写
- [x] Queue HTTP 出图契约不变；浏览器拿不到公开 R2 URL
- [x] 行为测试仍注入内存 adapter，不打真实 R2
- [x] 文档/运行说明写明：生命周期规则必须绑此前缀、禁止整桶过期
- [x] 孤儿对象依赖 7 天过期回收，应用不再靠扫库删像素字节来保证正确性
