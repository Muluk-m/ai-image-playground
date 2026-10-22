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
- 进入 `verifying` 后这一行就冻结，后台校验看到的元数据不能再被改：
  - 只对带了 `asyncMediaConfirm` 的请求暴露 `verifying`。同一账号的旧标签页会因为 `(user_id, sha256)` 去重碰到新客户端已经切成 `verifying` 的行，而现在的 `mediaTransfer.ts` 只认 `ready`/`pending`：reserve 没有 `uploadUrl` 就失败，complete 只要不是 `ready` 就报 `invalid_media_confirmation`。所以不带能力位的 reserve 和 complete 碰到 `verifying` 行时，服务端在请求内等这次共享校验出结果（订阅同一行的状态变化，上限沿用现在同步确认的时限）。等之前必须先结束持锁的事务：reserve（`reserveOwnedMedia`）和 complete 都在事务里锁着用户行，而后台校验发布 `ready` 或写 `rejected` 时也要拿同一把用户行锁，在事务里等会让两边互等到超时。所以请求在锁内只读出行状态是 `verifying`，提交或回滚事务、放掉所有行锁后再订阅状态变化并等待。放锁到订阅生效之间后台校验可能已经发布结果，只等「之后的变化」会漏掉这次转换，旧客户端白等到超时。所以等待按「先订阅、再重读」的顺序：先装好订阅，再在事务外重读一次这一行，已经是 `ready` 或 `rejected` 就直接返回，仍是 `verifying` 才开始等；等待期间另按固定间隔（如 1s）重读一次兜底，订阅通知丢失也不会等满时限。测试覆盖「放锁后、订阅前校验已发布，等待方立即拿到结果，不等到超时」。拿到结果后如果还要改行（例如 reserve 给旧格式补 `ready` 字段），重新开事务按原加锁顺序再读一次，以那时的状态为准。`accessMedia` 同样在事务外等。测试覆盖「旧客户端 reserve/complete/accessMedia 在 `verifying` 上等待期间，后台校验能拿到用户行锁并发布，等待方随后拿到结果」。成功后回旧格式的 `ready`；被拒时回现在同步路径的 422 错误码；超时回现在已有的 503 `media_processing_busy`，旧客户端本来就会重试它。旧客户端看不到 `verifying` 和 `rejected` 这两个值。
  - 带能力位的 reserve 遇到同 hash 的 `verifying` 行时，和 `ready` 一样当作不可变：不改 `bytes`、`content_type`、`expires_at`，不再签发 PUT URL，直接返回 `{ id, status: 'verifying' }`。客户端按「处理中」处理，等状态结果。申报的描述（字节数、类型）和行里的不一致时返回 409 `media_descriptor_mismatch`，不悄悄沿用旧行。
  - 发布前的复核除了暂存 key，也核对 `bytes` 和 `content_type` 仍等于开始校验时读到的快照，不一致就放弃这次发布，重新排队校验，不提交过时的元数据。
- `complete` 按当前状态幂等：202 响应可能丢失，客户端会重试 POST，重试到达时后台可能已经出结果。`complete` 先在锁内读状态，`verifying` 直接再回 202，不重新处理；`ready` 回 200 和现在一样；`rejected` 回 422，错误码从 `rejected_reason` 映射，与 `accessMedia` 一致。这时不读暂存对象，墓碑的 sha256 已被改写、暂存对象也已删除，重新处理只会得到存储或 hash 错误。只有 `pending` 才走首次 complete 的检查和状态切换。
- 解码、预览、发布由 bff 后台队列做。复用现在的 `withMediaProcessing` 和字节限额，进程重启后由扫描任务接着处理 `verifying` 状态。完成后置为 `ready`；只有确定性的校验失败（类型不支持、超像素、超出处理预算、动图、字节损坏，以及这次上传的 hash 或类型与申报不符）才置为 `rejected` 并带原因。其中 hash 或类型不符只说明这一次传的字节或描述不对，不代表这张图本身不合法，所以只拒这一行，不进下面的 `media_rejections` 去重缓存。超出处理预算指 `assertMediaImageProcessingBudget` 抛的 `processing_budget`：边长超过 `MAX_EDGE`，或者渐进式/WebP 解码的工作集超过 `DECODE_WORKING_SET_BYTES`。这两项只取决于图片本身的元数据，重试结果不会变，现在的同步路径对外也是 422 `media_image_processing_limit`。现在的代码把解码超时（`/timeout/`）也归到 `processing_budget`，异步化时要拆开：超时可能只是机器忙，按瞬时错误退避重试；同一行累计超时 3 次才置 `rejected`，原因码用单独的 `decode_timeout_limit`（对外错误码仍是 `media_image_processing_limit`），不和元数据判定的 `processing_limit` 混用（次数记在第 3 节迁移新增的 `verify_timeouts` 列），避免一张图永远卡在「处理中」、一直占着配额。R2 读写故障、处理容量不足这类瞬时错误（现在的发布路径对外是可重试的 503）不改状态，行留在 `verifying`，由扫描任务退避重试；暂存对象也不删。重试不能每次都留一份垃圾：现在的发布路径每次尝试都新起一个随机候选前缀，只在 `finally` 里尽力删除，同一次故障里删除也失败时这个前缀就丢了，无限重试会一直漏服务端对象。所以异步校验的候选前缀按行固定：第一次发布前把候选前缀写进这一行（见第 3 节迁移的 `publish_prefix` 列），之后的重试复用同一个前缀、覆盖写同名对象，不再新起；发布成功时这个前缀就是正式位置，转 `rejected` 或行被删除时按这一列删掉前缀下的对象，删除失败留给清理任务按这一列重试。这样一行最多只占一份候选对象。测试覆盖「写完原图后 R2 故障、删除也失败，重试 3 次后发布成功，存储里只有一份对象」。
- 画布文档允许引用 `verifying` 状态的 `mediaId`：`canvasSyncStore` 的所有权检查改为 `status IN ('verifying','ready','rejected')`。`rejected` 也必须放行：`accessCanvasDocument` 每次更新都校验整份文档，上传设备离线时，被拒的节点会一直留在文档里，只放行 `verifying`/`ready` 会让之后所有不相关的编辑都因 `canvas_media_not_owned` 失败。被拒的引用在文档里是墓碑，只用于显示「图片无效」，`accessMedia` 对它返回 422，不签发 URL。
- 本机：节点继续用本机原图显示，不必等预览。
- 别的设备：看到 `verifying` 的节点时显示「图片处理中」，拿到 `ready` 事件后再拉预览。已有的 WS 通道可以推一条 `media.ready` 或 `media.rejected`。
- WS 状态帧要协商：现在的 `readCanvasSyncMessage` 只认 vector/update/ack 三种帧，`CloudNodeProjectSession` 把解析失败当格式错误并关掉连接。旧标签页连着时，另一台设备异步上传，服务端推的新帧会把旧标签页的同步打断。所以客户端连 WS 时在 URL 上带能力位（如 `?caps=mediaStatus`），服务端只给声明了它的连接推 `media.ready`/`media.rejected` 事件和重连快照，旧连接一条新帧都不发。旧标签页看到文档里 `verifying` 的 `mediaId` 时照旧调 `accessMedia`：不带能力位的 `accessMedia` 碰到 `verifying` 行，和旧客户端的 complete 一样在请求内等校验结果，成功回签名 URL，被拒回 422，超时回 503 让它重试，不会看到新状态值。测试覆盖「旧协议连接在别的设备异步上传期间不收到新帧、连接不断」。
- 状态事件只是加速，不能是唯一来源：校验可能在引用进文档之前就完成，设备也可能正好断线，而项目 WS 重连时只重放 Yjs 文档，文档里只有 `mediaId`，没有校验状态。所以（1）WS 订阅/重连时，服务端对文档里仍在 `verifying` 或已 `rejected` 的 `mediaId` 补发一次当前状态快照；（2）客户端对每个停在「处理中」的节点用 `accessMedia` 退避轮询（如 2s、4s、8s，上限 30s），直到 `ready` 或 `rejected`。事件、快照、轮询任一先到即可。三条路径都要带上拒绝原因：原因存在 `media_objects.rejected_reason`（见第 3 节迁移），快照和 `accessMedia` 的 422 响应体都从这一列读，不依赖那条可能丢失的实时事件。
- 失败：变成 `rejected` 后，服务端从文档里拿不掉这个引用，所以由客户端负责。上传设备收到 `media.rejected` 后，在本机显示原图并标「无效」和原因（不支持的类型、超像素、动图等），其他设备显示「图片无效」。被拒的节点不能简单清掉 `mediaId` 回到「本机 fileId、无 mediaId」：`CloudNodeProjects.send()` 在发送前会让 `prepareMedia()` 自动收编所有「有 fileId 没 mediaId」的节点，原图绑定会马上把被拒的 id 写回去；绑定清掉的话，reserve 又会被 `media_rejections` 回 422，`prepareMedia()` 在发送前抛错，这台设备之后的所有编辑都发不出去。所以：
  - 节点保留墓碑 `mediaId`（服务端放行 `rejected` 引用，见上一条）。拒绝状态按 `mediaId` 记，不记在节点上：一个节点可以有多个候选结果，`prepareMedia()` 对节点主图和 `nodeResults` 里的每个候选分别上传，`promoteCanvasStoredResult()` 把各自的 `mediaId` 写在各自的结果上；只在节点的 `data.meta` 写一个 `mediaRejected`，非当前候选被拒时会把正常的主图也标成无效，不写又会在之后切到那个候选时丢掉拒绝状态。所以文档里新增一张按 `mediaId` 为键的 Y.Map `mediaRejections`（`mediaId → 原因码`），跟文档一起同步。下文说的「带 `mediaRejected`」都指「这个节点主图或候选结果的 `mediaId` 在 `mediaRejections` 里」：显示时按当前显示的那个结果的 `mediaId` 查表，节点主图和每个候选各查各的。服务端校验只放行键是本用户、状态为 `rejected` 的媒体行。`prepareMedia()` 只处理没有 `mediaId` 的节点和结果，自然跳过它们；本机按 `fileId` 显示原图，别的设备按表显示「图片无效」。测试覆盖「节点的非当前候选被拒，主图照常显示；切到被拒的候选后显示无效」。
  - 删绑定前先留下本机原图的反查：`prepareMedia()` 收编时 `promoteCanvasResultMedia()` 已经把节点的 `fileId` 改成 `cloud-${mediaId}`，`projectToEditor()` 会把它投影成 `aip-media:${mediaId}`，显示时去调 `accessMedia`，而墓碑故意回 422，上传设备就看不到原图了。所以被拒时在本机另存一张「被拒结果 → 原图」表（键是节点主图或候选结果的 id，不用 `mediaId`，因为下面同步回退的溢出墓碑会被多个节点共用；值是本机 `data:` 原图，跟本机原图文件一起持久化，刷新后还在），`projectToEditor()` 遇到带 `mediaRejected` 的节点先查这张表，查到就投影成本机原图加「无效」标记，查不到（别的设备、或本机原图已被清理）才显示「图片无效」，都不调 `accessMedia`。之后再删掉可复用的 source→mediaId 绑定，避免把被拒的 id 绑到别的节点上；这张反查表只用于显示，`prepareMedia()` 和上传声明都不读它。节点删除或墓碑被回收后对应条目一并清掉。测试覆盖「收编后被拒，上传设备刷新前后都显示本机原图加无效标记，不调 `accessMedia`」。
  - 用户再次导入同一张图时，新节点的 reserve 会命中 `media_rejections`。文档里不能出现「本机 fileId、没有 mediaId、带 `mediaRejected`」这种形态：它走普通 Yjs 更新同步，WS 能力位挡不住；旧客户端的 `prepareMedia()` 把所有「有 fileId 没 mediaId」的节点都当成要上传，别的设备上没有原图会抛 `canvas_media_missing`，导入的那台旧标签页 reserve 又回 422，之后的编辑都发不出去。所以命中缓存时，服务端给出一个服务端认可的墓碑身份：`media_rejections` 记着最近一次的墓碑 `media_id`；那一行还在就直接复用，已被回收就按缓存的原因新建一行没有字节的 `rejected` 墓碑并更新指针（每条拒绝记录同时至多一行墓碑，数量受第 1 条的上限约束，不另开口子）。reserve 回 422，响应体带上这个墓碑 `mediaId` 和原因码；新客户端给节点写上墓碑 `mediaId` 和 `mediaRejected`，与校验被拒的节点完全同形。旧客户端看到的是带 `mediaId` 的节点，`prepareMedia()` 跳过它，`accessMedia` 回 422，和看到别的被拒节点一样，不会卡住发送。`prepareMedia()`、上传声明（`claimLocalUploads`）和 `hasLocalImages()` 仍跳过带 `mediaRejected` 的节点作为兜底；`mediaRejections` 的键必须是文档里实际引用的墓碑 `mediaId`，不会出现没有 `mediaId` 的被拒节点。
  - 测试要覆盖「被拒后继续编辑，文档照常发出，节点不会被自动收编回被拒的 id」、「重新导入同一张被拒的图，节点带上墓碑 `mediaId` 标为无效，之后的编辑不被 422 卡住」、「墓碑已被回收时重新导入会新建墓碑并更新指针」和「旧协议客户端连着时有人重新导入被拒的图，旧客户端不报缺图、照常发送编辑」。
- 依赖确认结果的地方要改成等 `ready`：生成任务拿这张图做参考图、导出、分享、智能体读图。统一在取签名 URL 的 `accessMedia` 处等待，或返回 409 `media_verifying` 让调用方重试。
- 收益：从用户视角看，图片节点在 PUT 完成时就「已保存」，4 张图的总时间约为 reserve 加 PUT 的最大值。按 test 环境实测，约 1.5–2s，原来是 4s 以上。

## 3. 推荐路线
1. **A（单独 PR）**：只改服务端，不改协议，确认从约 1.7s 降到约 1.0s。
2. **B + C（需要评审的协议变更）**：
   - DB 迁移：`media_objects_status_check` 加 `verifying` 和 `rejected`；新增列 `verify_timeouts integer not null default 0`（这一行累计的解码超时次数，只给超时计数用）、可空列 `publish_prefix`（异步发布固定使用的候选前缀，重试复用、失败时按它清理）和可空列 `rejected_reason`，存稳定的原因码（`unsupported_type`、`pixel_limit`、`processing_limit`、`animated`、`corrupt`，以及不代表图片本身不合法的 `decode_timeout_limit`、`hash_mismatch`、`type_mismatch`）。`processing_limit` 对应现在的 `media_image_processing_limit`，`accessMedia` 的 422 响应体沿用这个错误码，置 `rejected` 时和状态同一条 UPDATE 写入，在删除暂存对象之前落库。
   - API：`complete` 返回 202；新增 WS 事件；`accessMedia` 增加 `media_verifying`。
   - shared：画布校验接受 `verifying`；新老客户端兼容。旧客户端只认 `ready`，所以 `complete` 要看 capabilities 位 `asyncMediaConfirm` 决定：只有新客户端带 `prefer: async` 时才返回 202，旧客户端仍然同步等待。
   - 新老服务端也要兼容：现在的 `canvasSyncStore` 只放行 `status = 'ready'`，回滚或灰度混跑时，旧 BFF 会拒绝所有仍含 `verifying`/`rejected` 节点的文档更新，而 `rejected` 节点永远不会变回 `ready`。所以分两次发布：
     1. 扩展版：DB 迁移、`canvasSyncStore` 放行三种状态、`accessMedia` 认识 `verifying`/`rejected`、快照和轮询路径都上线，但服务端从不写这两个状态，`complete` 仍然同步。
     2. 启用版：扩展版在所有实例上跑稳后，用服务端开关 `ASYNC_MEDIA_CONFIRM`（默认关）打开 202 和后台校验。
   - 开关只管「要不要新建 `verifying`」：`ASYNC_MEDIA_CONFIRM` 只决定 `complete` 是回 202 并把行置为 `verifying`，还是照旧同步处理。后台校验 worker 和重启扫描任务不看开关，启用版及之后的每个实例上都一直运行，只要库里还有 `verifying` 行就继续处理。否则关开关回滚时，存量 `verifying` 行没人处理，客户端会一直停在「处理中」，下面「等 `verifying` 为 0」这一步也永远等不到。测试要覆盖「开关关闭后，已有的 `verifying` 行仍会被处理成 `ready`/`rejected`，新的 `complete` 走同步路径」。
   - 回滚边界：开关一旦打开过，扩展版就是回滚下限，任何回滚都只退到扩展版、再关开关，不退到扩展版之前。原因是关开关只能让存量 `verifying` 处理完，处理结果里的 `rejected` 墓碑会按设计一直留在文档里；扩展版之前的 BFF 只放行 `ready`，会让这些画布之后的每次更新都因 `canvas_media_not_owned` 失败。
   - 如果确实要退到扩展版之前，必须先做一次单独评审的数据迁移，不能只等 `verifying` 清空：（1）关开关，等 `verifying` 为 0；（2）按 `accessCanvasDocument` 的加锁顺序（先用户行再项目行），把每份文档里引用 `rejected` 媒体的节点改成旧 BFF 能接受的形态（去掉 `mediaId`、回到占位节点），同时删掉对应的 project 引用；（3）确认全库文档里 `rejected` 引用数为 0，墓碑行交给 `purgeRejectedMedia` 回收；（4）这时才允许部署扩展版之前的版本。迁移脚本只在 test 演练，生产执行需要单独批准。
   - 预留期不能卡住校验：现在 `processMedia` 的锁内检查、`publishMedia` 的开头和发布前复核都会拒绝 `expires_at <= now`（`media_upload_expired`）；过期待上传行的清理任务也会按 `expires_at` 删掉暂存对象。行进入 `verifying` 时客户端已经传完，过期只该约束「还没传完的预留」。所以：（1）上面三处过期检查都改为只对 `pending` 生效，`verifying` 跳过；（2）过期清理的条件加上 `status = 'pending'`，不碰 `verifying` 行和它的暂存对象；（3）不靠延长租期：重启或 R2 故障拖多久都不确定，续期总会有拖过的时候。`verifying` 停留过久（比如超过 1 小时）只告警，不自动删除；扫描任务按退避一直重试，直到 `ready` 或确定性失败转 `rejected`。测试要覆盖「行在 `verifying` 期间过了 `expires_at`，重启后扫描任务仍能发布成 `ready`」；以及「边长或工作集超出处理预算的图直接转 `rejected`（`processing_limit`），不进重试」、「解码超时前两次留在 `verifying`，第三次转 `rejected`」、「`verifying` 期间同 hash 的 reserve 不改行、不签 URL」和「`complete` 在 `verifying`/`ready`/`rejected` 下重试分别回 202/200/422，且不读暂存对象」和「不带能力位的 reserve/complete 碰到 `verifying` 行时等校验结果，只回旧格式的 `ready`、422 或 503」。
   - 计费和配额：`reserved_bytes` 在 reserve 时占用，但 `mediaUsage` 对非 ready、非附件的行只在 `expires_at > now` 时计入，后台校验拖过 20 分钟预留期（比如长时间重启）时 `verifying` 行会提前不计，用户就能超额预留。所以 `mediaUsage` 把 `status = 'verifying'` 也列为一直计入，直到变成 `ready`（照常计）或 `rejected`（`reserved_bytes` 置 0）。
   - `rejected` 的回收要单独设计，不能交给现有的 sweep：普通画布上传 `attachment_managed = false`，而 `purgeExpiredAttachmentMedia` 只扫 managed 附件；文档里的引用还会保护这行不被删。方案：
     - 置 `rejected` 时立即删除暂存对象（服务端专用 key 尚未写入）；行本身保留为墓碑，保留暂存 key，`reserved_bytes` 按 0 计。
     - 墓碑不能挡住重试：`media_objects` 在 `(user_id, sha256)` 上唯一，reserve 会复用同 hash 的旧行，而现在的更新路径不重置 status，重试同一张图会一直拿回那个被拒的 id。所以置 `rejected` 的同一条 UPDATE 把墓碑行的 `sha256` 改成 `rejected:<id>`，让出唯一键。之后重试走正常的新建路径：新 id、新暂存 key、新预留；文档里旧 id 的墓碑引用不受影响，由客户端换成新 id。原因码是 `unsupported_type`、`pixel_limit`、`processing_limit`、`animated` 这类确定性失败时，客户端不自动重试，只在用户重新导入时才会再传。
     - 墓碑数量要有上限：改写 hash 后，同一张非法图每次重新导入都会新建一行墓碑，`reserved_bytes` 又按 0 计，配额挡不住，脚本或反复导入能无限制地造行。所以加两道限制：
       1. 确定性失败去重：新增 `media_rejections`（`user_id`、`sha256`、`reason`、`rejected_at`，主键 `(user_id, sha256)`），置 `rejected` 的同一事务里 upsert 一条。reserve 先查这张表：同一用户、同一 hash 在 7 天内有记录时，直接回 422 和原来的错误码，不签 URL，也不建 `pending` 行；响应体带上墓碑 `mediaId`（表里多一列 `media_id` 指向最近一次的墓碑，已被回收时按缓存原因补建一行无字节的 `rejected` 墓碑，见第 2 节「用户再次导入」）。每个用户每个 hash 至多一条，记录超过 7 天由 `purgeRejectedMedia` 一并删除。
          - 只缓存「只取决于字节本身」的失败：`unsupported_type`（按解码出的真实格式判断，与申报类型无关）、`pixel_limit`、`processing_limit`（只指边长或工作集超预算这类由元数据判定的失败）、`animated`、`corrupt`，而且只在后台已确认读回字节的 SHA-256 等于申报值之后才写，保证键就是这份字节。
          - 不缓存：`hash_mismatch`（A+C 回退下，同大小的陈旧或错误 PUT 会让 hash 对不上，重传正确的字节就能成功）、`type_mismatch`（改正申报的类型就能成功）、`decode_timeout_limit`（累计超时可能只是机器忙，正常的图下次可能就能解完）。它们只拒当前这一行，用户或客户端可以立即用正确的字节或描述重试，走正常新建路径。
       2. 每用户上限，在会产生墓碑的那一步原子地占名额：reserve 本身不产生墓碑（`pending` 行过期就清理），只有 `pending → verifying` 的行之后才可能变成墓碑。所以名额在 `complete` 把行切到 `verifying` 时占：同一事务里先锁用户行（`users ... FOR UPDATE`，与 `accessCanvasDocument` 同样的加锁顺序），统计「24 小时内新建的 `rejected` 墓碑 + 当前 `verifying` 行」，达到 50 就不切 `verifying`，这一次改走同步确认，通过则直接 `ready`。同步路径被拒时不能照旧删行、回不带墓碑的 422：节点就回到「本机 fileId、没有 mediaId」，`prepareMedia()` 每次发送都会重传、被拒、抛错，第 51 张非法图又会卡住之后所有编辑。所以同步被拒时也给一个服务端认可的墓碑身份，但不新增墓碑：每个用户有一行固定的「溢出墓碑」（`rejected`、没有字节、原因码 `rejected_limit`，第一次用到时在同一把用户行锁下创建，之后一直复用，不计入 50 的名额；被 `purgeRejectedMedia` 回收后下次用到再建）。被拒的这一行照旧删除，回 422，响应体带上溢出墓碑的 `mediaId` 和这次的真实原因码；客户端给节点写上这个 `mediaId`，`mediaRejections` 里它对应 `rejected_limit`，本机按上面的反查表显示原图加无效标记和真实原因，别的设备显示「图片无效」。确定性失败照常写 `media_rejections`，指针指向溢出墓碑。这样同步回退的被拒节点和其他墓碑同形，每个用户最多多出一行。因为每个可能变成墓碑的行在进入 `verifying` 前都占过名额，且计数和切状态在同一把用户行锁下完成，并发 complete 不会一起越过上限；先大量 reserve、再一起 complete 也只能有 50 行进入 `verifying`。置 `rejected` 时不再检查，不会出现「已经验完却无处安放」。不同的非法文件也只能造出有限的墓碑，旧墓碑照常 7 天后回收。reserve 时再查一次「24 小时内墓碑已满 50」，满了直接回 429 `media_rejected_limit`，只是提前告知，不是上限本身的保证。
       测试要覆盖「同一张非法图重复 reserve 只建一行墓碑，后续直接回 422」、「`decode_timeout_limit`、`hash_mismatch`、`type_mismatch` 被拒后可以用正确的字节或描述重试并建新行，不被缓存挡住」、「先 reserve 100 个不同的非法文件再并发 complete，最多 50 行进入 `verifying`，其余走同步路径、都拿到同一个溢出墓碑 `mediaId`，之后的编辑照常发出」和「24 小时内墓碑满 50 后 reserve 回 429」。
     - 只删一次不够：预签名 PUT 有效期 600 秒（`durableMediaStore.sign`），客户端在这期间重试 PUT 会把暂存对象重新建出来。所以 `purgeRejectedMedia` 在删行之前按行里保存的暂存 key 再删一次对象（对象不存在也算成功）；删行发生在 `rejected` 7 天后，远超签名有效期，此后不会再有对象被建出来。
     - 项目引用要先清：`canvasSyncStore` 写 `media_references` 只增不删，节点从文档里消失后那条 `owner_kind = 'project'` 的边还在，而外键是 `onDelete: 'restrict'`，墓碑行永远删不掉。所以 `purgeRejectedMedia` 对每个候选行，按 `accessCanvasDocument` 的加锁顺序先锁媒体所有者的用户行（`users ... FOR UPDATE`），再锁项目行并读当前文档；只锁项目行不够，画布更新先锁用户行、到最后写入时才锁项目行，两边会交错，导致刚被删掉的媒体 id 又被写回文档。持锁后，文档已不再引用这个 `mediaId` 的项目，删掉对应的 project 引用；被拒的媒体没有有效字节，迁移归档用不到这些边。删引用和删行在同一个持着用户行锁的事务里完成：其他 `owner_kind` 的引用也不存在时才删行，否则留到下一轮。
     - 「文档已不再引用」按 `canvasSyncStore` 校验所有权时同一套规则算，包括 `nodeResults` 里的候选结果（`canvasResultMediaIds`）。删节点的 `deleteCanvasNode` 只删节点，结果条目还留着，所以被拒结果要由客户端清掉，服务端不去猜哪些结果算孤儿：`deleteCanvasNode` 在同一个事务里，把这个节点下 `mediaId` 在 `mediaRejections` 里的结果条目一起删掉（正常结果照旧保留，不影响撤销）；客户端加载文档和每次发送前再扫一遍，删掉 `nodeId` 已不在节点表里、且 `mediaId` 被拒的结果条目（兼容旧客户端删节点留下的）；最后把 `mediaRejections` 里已没有节点或结果引用的键删掉。三步都走普通 Yjs 更新，旧客户端照常同步。这样服务端的引用判断和所有权校验口径一致：结果还在就算引用、不删行，下一次画布更新不会因为缺行而失败；结果被清掉后，这一行在下一轮正常回收。一直没人再打开的文档会让墓碑行一直留着，但它没有字节、`reserved_bytes` 为 0，只占一行。测试覆盖「删除被拒节点后，它的被拒结果和 `mediaRejections` 条目一并消失，`purgeRejectedMedia` 随后能回收墓碑；正常结果不受影响」。
     - 定时任务删除的条件：`rejected` 超过 7 天；暂存 key 和 `publish_prefix` 下的对象都已删除成功（幂等，对象不存在也算成功），任一删除失败就保留这一行、下一轮重试，因为删行后就没有地方再记着这个前缀，候选对象会永久泄漏；且上面几步做完后已没有任何引用。删行之前先删对象，不反过来。测试覆盖「`publish_prefix` 删除持续失败时墓碑行不被删，恢复后下一轮先删对象再删行」。

## 4. 风险与待定
- **C 的跨设备体验**：别的设备会短暂看到没有预览的节点，需要设计「处理中」占位。
- **C 的失败回退**：用户可能已经基于这张图做了连线、发起生成。生成路径必须等 `ready`，否则会拿到未校验的图。
- **B 的 R2 兼容性**：预签名 URL 带 checksum 头需要实测；不支持就只做 A + C，后台照常读回算 hash。
- **A 的 ETag 条件拷贝**：R2 支持 `x-amz-copy-source-if-match`，需要在 test 桶上验证。
- **监控**：P1-3（#1455）的前端分段计时，加上服务端 `media.confirmation_finished` 的 phaseMs，用来对比每一步上线前后的耗时。

## 5. 验收
- 4 张 0.36–1.2MB jpeg：从点「确定导入」到状态栏「已保存」，test 环境 ≤ 3s。目前 P0-1 到 P1-1 合计约 4–5s，main 约 17s。
- 11 张 PNG：用户网络 ≤ 30s。原来约 73s。
- 非法图片：上传设备 5s 内收到 `rejected`，节点保留墓碑 `mediaId`，文档的 `mediaRejections` 记下原因，本机显示原图加「无效」标记，之后的编辑照常发出、不会被自动重新上传；其他设备显示「图片无效」。
