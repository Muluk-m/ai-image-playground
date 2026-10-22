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
- checksum 只签给声明支持的客户端：现在的 `mediaTransfer.ts` PUT 只带 `content-type`，签进 checksum 的 URL 会让旧客户端的 PUT 直接失败，而 `prefer: async` 要到 `complete` 才看得到，那时 PUT 已经失败了。所以由 reserve 请求带上 `asyncMediaConfirm` 能力位，服务端只对带了它的请求签 checksum 并返回要带的头；不带的旧客户端拿到和现在一样的 URL，`complete` 也走同步。
- 浏览器跨域 PUT 带 `x-amz-checksum-sha256` 会先发预检，而 `deploy/r2-media-cors.json` 现在只放行 `Content-Type` 和 `Range`。启用前要把这个头加进 `headers`，并先应用到 test 桶、再随发布应用到生产桶（属于扩展版那一次发布）；只验证 R2 的签名和校验支持，浏览器请求仍然用不了。
- 需要先在 test 桶上实测 R2 对预签名 URL 里 checksum 头的支持（R2 文档声明支持 `x-amz-checksum-*`；预签名场景要实测）。

### 方案 C：确认异步化（真正把确认移出关键路径，推荐作为 P0-3 主体）
- `POST /api/media/:id/complete` 只做廉价检查：所有权、大小（`HEAD` 或 B 的 checksum 结果）。检查过后把状态置为新的 `verifying`，立即返回 `202 { id, status: 'verifying' }`。
- 解码、预览、发布由 bff 后台队列做。复用现在的 `withMediaProcessing` 和字节限额，进程重启后由扫描任务接着处理 `verifying` 状态。完成后置为 `ready`；只有确定性的内容校验失败（类型不支持、超像素、动图、字节损坏或 hash 不符）才置为 `rejected` 并带原因。R2 读写故障、处理容量不足这类瞬时错误（现在的发布路径对外是可重试的 503）不改状态，行留在 `verifying`，由扫描任务退避重试；暂存对象也不删。
- 画布文档允许引用 `verifying` 状态的 `mediaId`：`canvasSyncStore` 的所有权检查改为 `status IN ('verifying','ready','rejected')`。`rejected` 也必须放行：`accessCanvasDocument` 每次更新都校验整份文档，上传设备离线时，被拒的节点会一直留在文档里，只放行 `verifying`/`ready` 会让之后所有不相关的编辑都因 `canvas_media_not_owned` 失败。被拒的引用在文档里是墓碑，只用于显示「图片无效」，`accessMedia` 对它返回 422，不签发 URL。
- 本机：节点继续用本机原图显示，不必等预览。
- 别的设备：看到 `verifying` 的节点时显示「图片处理中」，拿到 `ready` 事件后再拉预览。已有的 WS 通道可以推一条 `media.ready` 或 `media.rejected`。
- 状态事件只是加速，不能是唯一来源：校验可能在引用进文档之前就完成，设备也可能正好断线，而项目 WS 重连时只重放 Yjs 文档，文档里只有 `mediaId`，没有校验状态。所以（1）WS 订阅/重连时，服务端对文档里仍在 `verifying` 或已 `rejected` 的 `mediaId` 补发一次当前状态快照；（2）客户端对每个停在「处理中」的节点用 `accessMedia` 退避轮询（如 2s、4s、8s，上限 30s），直到 `ready` 或 `rejected`。事件、快照、轮询任一先到即可。三条路径都要带上拒绝原因：原因存在 `media_objects.rejected_reason`（见第 3 节迁移），快照和 `accessMedia` 的 422 响应体都从这一列读，不依赖那条可能丢失的实时事件。
- 失败：变成 `rejected` 后，服务端从文档里拿不掉这个引用，所以由客户端负责。上传设备收到 `media.rejected` 后，把节点打回 `media-local` 并给出原因：不支持的类型、超像素、动图。其他设备显示「图片无效」。
- 依赖确认结果的地方要改成等 `ready`：生成任务拿这张图做参考图、导出、分享、智能体读图。统一在取签名 URL 的 `accessMedia` 处等待，或返回 409 `media_verifying` 让调用方重试。
- 收益：从用户视角看，图片节点在 PUT 完成时就「已保存」，4 张图的总时间约为 reserve 加 PUT 的最大值。按 test 环境实测，约 1.5–2s，原来是 4s 以上。

## 3. 推荐路线
1. **A（单独 PR）**：只改服务端，不改协议，确认从约 1.7s 降到约 1.0s。
2. **B + C（需要评审的协议变更）**：
   - DB 迁移：`media_objects_status_check` 加 `verifying` 和 `rejected`；新增可空列 `rejected_reason`，存稳定的原因码（`unsupported_type`、`pixel_limit`、`animated`、`corrupt`），置 `rejected` 时和状态同一条 UPDATE 写入，在删除暂存对象之前落库。
   - API：`complete` 返回 202；新增 WS 事件；`accessMedia` 增加 `media_verifying`。
   - shared：画布校验接受 `verifying`；新老客户端兼容。旧客户端只认 `ready`，所以 `complete` 要看 capabilities 位 `asyncMediaConfirm` 决定：只有新客户端带 `prefer: async` 时才返回 202，旧客户端仍然同步等待。
   - 新老服务端也要兼容：现在的 `canvasSyncStore` 只放行 `status = 'ready'`，回滚或灰度混跑时，旧 BFF 会拒绝所有仍含 `verifying`/`rejected` 节点的文档更新，而 `rejected` 节点永远不会变回 `ready`。所以分两次发布：
     1. 扩展版：DB 迁移、`canvasSyncStore` 放行三种状态、`accessMedia` 认识 `verifying`/`rejected`、快照和轮询路径都上线，但服务端从不写这两个状态，`complete` 仍然同步。
     2. 启用版：扩展版在所有实例上跑稳后，用服务端开关 `ASYNC_MEDIA_CONFIRM`（默认关）打开 202 和后台校验。
   - 回滚边界：开关一旦打开过，扩展版就是回滚下限，任何回滚都只退到扩展版、再关开关，不退到扩展版之前。原因是关开关只能让存量 `verifying` 处理完，处理结果里的 `rejected` 墓碑会按设计一直留在文档里；扩展版之前的 BFF 只放行 `ready`，会让这些画布之后的每次更新都因 `canvas_media_not_owned` 失败。
   - 如果确实要退到扩展版之前，必须先做一次单独评审的数据迁移，不能只等 `verifying` 清空：（1）关开关，等 `verifying` 为 0；（2）按 `accessCanvasDocument` 的加锁顺序（先用户行再项目行），把每份文档里引用 `rejected` 媒体的节点改成旧 BFF 能接受的形态（去掉 `mediaId`、回到占位节点），同时删掉对应的 project 引用；（3）确认全库文档里 `rejected` 引用数为 0，墓碑行交给 `purgeRejectedMedia` 回收；（4）这时才允许部署扩展版之前的版本。迁移脚本只在 test 演练，生产执行需要单独批准。
   - 预留期不能卡住校验：现在 `processMedia` 的锁内检查、`publishMedia` 的开头和发布前复核都会拒绝 `expires_at <= now`（`media_upload_expired`）；过期待上传行的清理任务也会按 `expires_at` 删掉暂存对象。行进入 `verifying` 时客户端已经传完，过期只该约束「还没传完的预留」。所以：（1）上面三处过期检查都改为只对 `pending` 生效，`verifying` 跳过；（2）过期清理的条件加上 `status = 'pending'`，不碰 `verifying` 行和它的暂存对象；（3）不靠延长租期：重启或 R2 故障拖多久都不确定，续期总会有拖过的时候。`verifying` 停留过久（比如超过 1 小时）只告警，不自动删除；扫描任务按退避一直重试，直到 `ready` 或确定性失败转 `rejected`。测试要覆盖「行在 `verifying` 期间过了 `expires_at`，重启后扫描任务仍能发布成 `ready`」。
   - 计费和配额：`reserved_bytes` 在 reserve 时占用，但 `mediaUsage` 对非 ready、非附件的行只在 `expires_at > now` 时计入，后台校验拖过 20 分钟预留期（比如长时间重启）时 `verifying` 行会提前不计，用户就能超额预留。所以 `mediaUsage` 把 `status = 'verifying'` 也列为一直计入，直到变成 `ready`（照常计）或 `rejected`（`reserved_bytes` 置 0）。
   - `rejected` 的回收要单独设计，不能交给现有的 sweep：普通画布上传 `attachment_managed = false`，而 `purgeExpiredAttachmentMedia` 只扫 managed 附件；文档里的引用还会保护这行不被删。方案：
     - 置 `rejected` 时立即删除暂存对象（服务端专用 key 尚未写入）；行本身保留为墓碑，保留暂存 key，`reserved_bytes` 按 0 计。
     - 墓碑不能挡住重试：`media_objects` 在 `(user_id, sha256)` 上唯一，reserve 会复用同 hash 的旧行，而现在的更新路径不重置 status，重试同一张图会一直拿回那个被拒的 id。所以置 `rejected` 的同一条 UPDATE 把墓碑行的 `sha256` 改成 `rejected:<id>`，让出唯一键。之后重试走正常的新建路径：新 id、新暂存 key、新预留；文档里旧 id 的墓碑引用不受影响，由客户端换成新 id。原因码是 `unsupported_type`、`pixel_limit`、`animated` 这类确定性失败时，客户端不自动重试，只在用户重新导入时才会再传。
     - 只删一次不够：预签名 PUT 有效期 600 秒（`durableMediaStore.sign`），客户端在这期间重试 PUT 会把暂存对象重新建出来。所以 `purgeRejectedMedia` 在删行之前按行里保存的暂存 key 再删一次对象（对象不存在也算成功）；删行发生在 `rejected` 7 天后，远超签名有效期，此后不会再有对象被建出来。
     - 项目引用要先清：`canvasSyncStore` 写 `media_references` 只增不删，节点从文档里消失后那条 `owner_kind = 'project'` 的边还在，而外键是 `onDelete: 'restrict'`，墓碑行永远删不掉。所以 `purgeRejectedMedia` 对每个候选行，按 `accessCanvasDocument` 的加锁顺序先锁媒体所有者的用户行（`users ... FOR UPDATE`），再锁项目行并读当前文档；只锁项目行不够，画布更新先锁用户行、到最后写入时才锁项目行，两边会交错，导致刚被删掉的媒体 id 又被写回文档。持锁后，文档已不再引用这个 `mediaId` 的项目，删掉对应的 project 引用；被拒的媒体没有有效字节，迁移归档用不到这些边。删引用和删行在同一个持着用户行锁的事务里完成：其他 `owner_kind` 的引用也不存在时才删行，否则留到下一轮。
     - 定时任务删除的条件：`rejected` 超过 7 天，且上面两步做完后已没有任何引用。

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
