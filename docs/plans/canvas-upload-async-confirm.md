# 节点画布上传 P0-3（设计）：把服务端确认移出「已保存」的关键路径

状态：设计稿，未实现。前置：#1450（P0-1 并发上传）、#1452（P0-2 上传中先同步文档）、#1453（P1-2 确认并发）、#1456（P1-1 确认少两次往返）。

## 1. 现状与剩余瓶颈

P0-1 到 P1-1 上线后，一张图上传仍是严格串行的三段：

```
reserve（≈50–200ms） → PUT 到 R2（≈0.9–1.3s，取决于用户上行） → complete（服务端确认）
```

complete 是同步的，返回 `ready` 后前端才拿到可以写进文档的 `mediaId`。服务端在这一步做的事：

| 步骤 | 目的 | P1-1 后耗时（test） |
|---|---|---|
| Range GET 读回暂存原件 | 内容不可信，要自己算 SHA-256、自己解码 | ≈650ms |
| sha256 + sharp 解码 + 生成 webp 预览 | 校验确实是声明的图片类型，拿宽高，生成预览 | ≈100ms |
| PUT 原件到新的服务端专用 key + PUT 预览 | 暂存 key 的预签名 PUT 在有效期内还能被改写，所以发布的必须是新 key | ≈950ms |
| 发布事务 | `media_objects.status = 'ready'` | ≈5ms |

一张图确认约 1.7s。用户网络越慢，PUT 段越长，但确认这一段的耗时是固定的。画布的「已保存」和别的设备能否看到这张图，都卡在确认完成上。P0-2 之后，挪节点之类的改动已经不再等确认，但图片节点本身仍要多等这 1.7s 才算上云。

## 2. 方案对比

### 方案 A：服务端拷贝代替回写原件（小改，可以单独先做）
- 发布原件时，不再由 bff 把整份字节 PUT 到新 key，改用 R2/S3 的 `CopyObject`（`x-amz-copy-source`），在服务端内部拷贝，字节不经过 VPS。
- Bun 的 `S3Client` 没有 copy 方法，需要自己签一个 `PUT` 请求，带 `x-amz-copy-source` 头。可以复用现有的 presign，或补一个最小的 SigV4 实现。
- 拷贝的必须是「刚校验过的那一版」。拷贝时带 `x-amz-copy-source-if-match: <校验时读到的 ETag>`，Range GET 读回时记下 ETag。这样就算暂存 key 在校验之后被改写，拷贝也会失败（412），不会发布未校验的内容。
- 预计省掉原件 PUT 约 600–800ms，剩下预览 PUT（几十 KB）。确认降到约 1.0s。
- 不改协议，只改服务端，风险低。

### 方案 B：签名时要求 SHA-256 校验和，R2 在 PUT 时验 hash
- reserve 返回的预签名 PUT 把 `x-amz-checksum-sha256` 签进去（值为客户端申报的 sha256 的 base64）。R2 收到的字节和它不匹配时，直接拒绝 PUT。
- 这只保证完整性，图片是否合法（类型、像素上限、动图）仍然要解码才能确认，所以服务端照样得读回字节。单独做 B 收益不大，要和方案 C 配合：C 把解码挪到后台，B 保证后台读到的就是客户端算过 hash 的那份。
- 需要先在 test 桶上实测 R2 对预签名 URL 里 checksum 头的支持（R2 文档声明支持 `x-amz-checksum-*`；预签名场景要实测）。

### 方案 C：确认异步化（真正把确认移出关键路径，推荐作为 P0-3 主体）
- `POST /api/media/:id/complete` 只做廉价检查：所有权、大小（`HEAD` 或 B 的 checksum 结果）。检查过后把状态置为新的 `verifying`，立即返回 `202 { id, status: 'verifying' }`。
- 解码、预览、发布由 bff 后台队列做。复用现在的 `withMediaProcessing` 和字节限额，进程重启后由扫描任务接着处理 `verifying` 状态。完成后置为 `ready`，失败置为 `rejected` 并带原因。
- 画布文档允许引用 `verifying` 状态的 `mediaId`：`canvasSyncStore` 的所有权检查改为 `status IN ('verifying','ready')`。
- 本机：节点继续用本机原图显示，不必等预览。
- 别的设备：看到 `verifying` 的节点时显示「图片处理中」，拿到 `ready` 事件后再拉预览。已有的 WS 通道可以推一条 `media.ready` 或 `media.rejected`。
- 失败：变成 `rejected` 后，服务端从文档里拿不掉这个引用，所以由客户端负责。上传设备收到 `media.rejected` 后，把节点打回 `media-local` 并给出原因：不支持的类型、超像素、动图。其他设备显示「图片无效」。
- 依赖确认结果的地方要改成等 `ready`：生成任务拿这张图做参考图、导出、分享、智能体读图。统一在取签名 URL 的 `accessMedia` 处等待，或返回 409 `media_verifying` 让调用方重试。
- 收益：从用户视角看，图片节点在 PUT 完成时就「已保存」，4 张图的总时间约为 reserve 加 PUT 的最大值。按 test 环境实测，约 1.5–2s，原来是 4s 以上。

## 3. 推荐路线
1. **A（单独 PR）**：只改服务端，不改协议，确认从约 1.7s 降到约 1.0s。
2. **B + C（需要评审的协议变更）**：
   - DB 迁移：`media_objects_status_check` 加 `verifying` 和 `rejected`。
   - API：`complete` 返回 202；新增 WS 事件；`accessMedia` 增加 `media_verifying`。
   - shared：画布校验接受 `verifying`；新老客户端兼容。旧客户端只认 `ready`，所以 `complete` 要看 capabilities 位 `asyncMediaConfirm` 决定：只有新客户端带 `prefer: async` 时才返回 202，旧客户端仍然同步等待。
   - 计费和配额：`reserved_bytes` 在 reserve 时就已占用，不受影响。`rejected` 的对象由现有的 managed media sweep 回收。

## 4. 风险与待定
- **C 的跨设备体验**：别的设备会短暂看到没有预览的节点，需要设计「处理中」占位。
- **C 的失败回退**：用户可能已经基于这张图做了连线、发起生成。生成路径必须等 `ready`，否则会拿到未校验的图。
- **B 的 R2 兼容性**：预签名 URL 带 checksum 头需要实测；不支持就只做 A + C，后台照常读回算 hash。
- **A 的 ETag 条件拷贝**：R2 支持 `x-amz-copy-source-if-match`，需要在 test 桶上验证。
- **监控**：P1-3（#1455）的前端分段计时，加上服务端 `media.confirmation_finished` 的 phaseMs，用来对比每一步上线前后的耗时。

## 5. 验收
- 4 张 0.36–1.2MB jpeg：从点「确定导入」到状态栏「已保存」，test 环境 ≤ 3s。目前 P0-1 到 P1-1 合计约 4–5s，main 约 17s。
- 11 张 PNG：用户网络 ≤ 30s。原来约 73s。
- 非法图片：上传设备 5s 内收到 `rejected` 并回到 `media-local`；其他设备显示「图片无效」。
