# 在一个部署里打开智能体

`agent:chat` deny by default，13 张实施票合并后它仍然是关的。这份文档是把它打开的可重复步骤，
2026-09-14 首次在 tx-vps 的 `image-playground-paid` 与 `image-playground-internal` 上按此执行。

改的全是部署侧的配置，**不改代码、不重新构建镜像**。只要镜像里已经有智能体代码（合并于 PR #345 之前），
照此走一遍即可。

## 零、先确认镜像里有代码

```sh
git ls-tree -r --name-only <部署中的 commit> -- apps/bff/src/lib/agent | head -1
```

有输出就继续；没有就先部署一个新镜像，本文档不涉及构建。

## 一、先验网关透不透传 `stream_options`

**这一步不能跳。** 不透传的话，轮的用量为空，结算按预留额全额收，用户被系统性多扣。

容器里通常没有 `curl`，从宿主机打，密钥只在 shell 变量里流转：

```sh
BASE=$(docker exec <bff 容器> printenv UPSTREAM_BASE_URL)
KEY=$(docker exec <bff 容器> printenv UPSTREAM_OPENAI_API_KEY)
curl -s "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"model":"<对话模型>","stream":true,"stream_options":{"include_usage":true},
       "max_tokens":16,"messages":[{"role":"user","content":"say ok"}]}' | tail -3
```

末帧必须是 `"choices":[],"usage":{...}` 那一条。看不到 `usage` 就**不要开计费上线**。

顺带看一眼 `$BASE/v1/models`，确认对话模型与摘要模型都在清单里。
生图、生视频不走这个网关，走 `apps/bff/channels.json` 的渠道，不用在这里找。

## 二、备份两个配置文件

```sh
d=~/.config/ai-image-playground/apps/<project>
ts=$(date -u +%Y%m%dT%H%M%SZ)
cp -a $d/app.env               $d/app.env.bak-agent-$ts
cp -a $d/operator-config.json  $d/operator-config.json.bak-agent-$ts
```

## 三、先写单价行，再开能力

顺序不能反：能力开着而单价缺失，每一轮都会在预扣这步被拒。反过来先写单价是惰性的，不影响现网。

`billing_model_prices` 的主键是**真实模型名**，不是伪模型 `agent-chat`——`start-turn.ts` 传的是
`config.agent.model`。`updated_at` 在库里是 `timestamptz`，用 `now()`，不要塞 epoch 毫秒。

```sql
insert into billing_model_prices
  (model, credits_per_image, unit, output_credits_per_unit, output_reserve_tokens, active, updated_at)
values
  ('<对话模型>', 2, 'kilo_token', 10, 1500, true, now())
on conflict (model) do update set
  credits_per_image       = excluded.credits_per_image,
  unit                    = excluded.unit,
  output_credits_per_unit = excluded.output_credits_per_unit,
  output_reserve_tokens   = excluded.output_reserve_tokens,
  active                  = excluded.active,
  updated_at              = excluded.updated_at;
```

`credits_per_image` 在 `unit='kilo_token'` 这行表示**每千输入 token 的积分数**，列名是历史遗留。
`outputPriceRatio` 由 `output_credits_per_unit / credits_per_image` 推出，
2 / 10 得 5，与 `FALLBACK_CHAT_PRICING` 的 5 一致。档位依据见
[`docs/research/agent-token-pricing.md`](../research/agent-token-pricing.md) 的 C 档。

**为什么是 C 档而不是调研推荐的 B 档。** 调研成文时智能体还是一个独立功能，一轮对话对标
一次出图，B 档的 60 积分（0.6 张图）合理。但创作模式的输入框合一之后（#351），出图要先过
一轮对话，两笔钱叠在一起：B 档下一张图从 100 变成 160，贵六成，用户会觉得对话在收过路费。
C 档一轮 20 积分，同一张图变成 120，多付两成，这个量级才不影响出图这个主业。

调研里 C 档标注为「贴钱」，那是按上游**官方价**算的。本项目走中转网关，图片单价当初也是按
中转价（官方价的 5~10%）定的，同一条基准下 C 档仍有正毛利。真要核准得拿到网关的实际计费口径。

只有收费部署需要这一步。免费部署没有计费表，跳过。

## 四、写环境变量

追加进 `$d/app.env`。重复执行前先 `sed -i '/^AGENT_[A-Z_]*=/d'` 保证幂等。

```sh
AGENT_CHAT_MODEL=gpt-5.6-luna
AGENT_CHAT_CONTEXT_WINDOW=40000
AGENT_CHAT_MAX_TOKENS=8000
AGENT_SUMMARY_MODEL=gpt-5.6-luna
AGENT_IMAGE_MODEL=gpt-image-2.5-flare
AGENT_VIDEO_MODEL=grok-imagine-video
```

`AGENT_CHAT_CONTEXT_WINDOW` **填的是预算窗口，不是模型标称窗口**。这是全文最容易配错的一项，
理由见下面「窗口为什么是 40000」。

生图与生视频模型必须是 `channels.json` 里的模型，且在单价表里 active，否则工具提交会被拒。
留空则取该类目的第一个，当前分别是 `gpt-image-2.5-flare` 与 `grok-imagine-video`。

`AGENT_SUMMARY_MODEL` 必须是网关**当下**还在供的模型。它配错不会让任何东西报错：摘要失败
只打一条 `warn`，轮照常完成，用户只是拿到被截断而不是被摘要的上下文。线上就这么静默跑了
一段时间——`gpt-5.4` 系列下架后这里还留着 `gpt-5.4-mini`，网关回 400「model is not
supported」，是确定性错误因而不重试，三次就把熔断器打开，压缩从此再没成功过一次。
配之前拿它打一次 `/v1/chat/completions`，别只看 `/v1/models`。

## 五、开能力，同时把阈值写死

`operator-config.json` 的 `capabilities` 加 `"agent:chat": true`，`quotas` 补齐九项。
**不要留默认值**：默认值是按 128k 窗口写的，配到 40000 的窗口上会立刻互相打架。

```json
"agent:compaction-output-reserve-tokens": 8000,
"agent:compaction-buffer-tokens": 8000,
"agent:compaction-verbatim-tokens": 6000,
"agent:compaction-keep-tokens": 6000,
"agent:compaction-failure-threshold": 3,
"agent:compaction-cooldown-minutes": 60,
"agent:turns-per-device-minute": 10,
"agent:turns-per-ip-hour": 200
```

### 窗口为什么是 40000

压缩触发点 = `contextWindow − min(maxOutputTokens, outputReserveTokens) − bufferTokens`。

照默认值（窗口 128000、预留 20000、缓冲 13000）算出来是 107000。每一轮都要重发全部历史，
按 6 积分/千输入 token，**一轮封顶 642 积分，约等于 6 张图**。在一个以出图为主业的产品里，
对话比出图还贵是错的定位。

所以窗口按「愿意为一轮花多少」倒推，而不是照抄模型标称窗口：

| 项 | 值 |
| --- | --- |
| 窗口 | 40000 |
| 减去输出预留 | 8000 |
| 减去缓冲 | 8000 |
| **触发点** | **24000 token** |
| **一轮封顶** | **约 144 积分 ≈ 1.4 张图** |

把窗口报小对 pi 是安全的：它只会以为模型窗口小，而我们在更早的位置就压缩了。
反过来报大才会溢出。

## 六、重启并核对

```sh
cd <checkout> && ./scripts/app-compose.sh up <project>
```

这只是带着新 env 重建容器，**不换镜像**。想连代码一起升级才用 `scripts/vps-deploy.sh`。

`app.env` 是 compose 的 `env_file`，整份注入容器；改完必须重建，`restart` 不重读。

核对三件事：

```sh
docker exec <bff> env | grep ^AGENT_
docker logs <bff> 2>&1 | grep capabilities.resolved | tail -1   # 每一项都应 source=file
curl -s <公开 API>/api/capabilities | grep -o '"agent:chat":[a-z]*'
```

## 七、冒烟

### 7.1 免费部署：匿名即可跑完整一轮

```sh
docker cp scripts/agent-smoke.ts <bff>:/tmp/
docker exec <bff> bun /tmp/agent-smoke.ts "画一只戴眼镜的橘猫，正方形"
```

期望看到 `toolStart → toolProgress → toolEnd → textDelta → turnEnd`，
`turnEnd` 里带 `usage:{inputTokens,outputTokens}`。**`usage` 为空就是第一步白做了，回去查网关。**

再确认没写任何积分流水：

```sql
select count(*) from tasks where kind = 'chat';   -- 免费部署应为 0
```

不开计费就不写任务行，也就没有流水。

### 7.2 收费部署：必须登录

计费开着时匿名起轮返回 401，这是对的。完整一轮要一个有积分的真实账号，在浏览器里走：

1. 说一句话 → 看到逐字回复
2. 让它画一张 → 图落画布
3. 页脚显示耗时与消耗
4. 积分账本上出现**预扣**与**结算**两条流水
5. 故意让一轮失败 → 积分按原桶退回，页脚显示未扣费

不登录也能先验计费算术：

```sh
docker exec -e DATABASE_URL="$(docker exec <bff> printenv APP_DATABASE_URL)" <bff> bun -e '
const m = await import("/app/apps/bff/src/lib/private-overlay.ts");
const o = await m.loadPrivateBffOverlay();
console.log(Object.keys(o.taskHooks).sort().join(", "));
console.log(await o.taskHooks.chatPricing("<对话模型>"));
'
```

六个钩子应齐全：`chatPricing, finalizeTask, onUserCreated, reserveTask, runMaintenance, taskCredits`。
`chatPricing` 应返回 `{outputPriceRatio:5, outputReserveTokens:2000}`；
未登记的模型返回 `null`，起轮会被拒，这是预期行为。

## 八、会绊人的地方

- **迁移序号缺 0013**，是实施中预留未用造成的，journal 连续可用，**不要去补**。
- **私有计费包按包跑测试会假红**（见 #343），逐个文件跑才准，不要因此判定迁移有问题。
- **能力开了但 `AGENT_CHAT_MODEL` 没配，服务会在启动时直接拒绝**，这是刻意的，不是故障。
- **本次改动只碰 `public` schema**，没有新建 schema，`POSTGRES_EXTRA_SCHEMAS` 不用动。
  以后若私有迁移新建 schema，必须登记并重跑 provision，否则每日 `pg_dump` 全库失败。
- **`ark-video`（Seedance）与 `veo-video` 渠道当前是关的**，缺 `ARK_BASE_URL` / `VEO_API_KEY`。
  它们在 `channels.json` 里，但没有单价行，指过去会被拒。

## 九、拆旧协议的发布不能静默

协议改成「服务端不再接受旧形式」时（例：#312 把设备标识从 query 挪到请求头），发布前就开着的
标签页还在跑旧 bundle，它发出去的请求会被新服务端直接拒。而 `NOTIFY_UPDATE` 默认是关的
（见 `scripts/pages-deploy.sh` 顶部说明）：静默发布下这些标签页不会收到更新提示，只有等到用户
下一次自然刷新才换到新 bundle，中间这段时间它们一直是坏的。2026-09-15 就是这样坏的：
#312 上线后，发布前开着的标签页里智能体历史列表点不动（#367）。

所以**只要这次发布里有「服务端不再接受旧请求形式」的改动，就必须二选一**，且在发布前定好：

1. **服务端留一版兼容**：新形式为主，旧形式继续接受，下一版再拆。多数情况下这是单行改动，
   优先选它——开着的标签页不会坏，回滚也不用前后端协调。
2. **带更新提示发布**：在 `pages.env` 里给这一版打开
   `INTERNAL_NOTIFY_UPDATE=true` / `PAID_NOTIFY_UPDATE=true`（直接跑 `scripts/pages-deploy.sh`
   时是 `NOTIFY_UPDATE=true`），开着的标签页立刻看到更新提示。顺序是**先发服务端再发前端**，
   这中间旧前端已经在被拒了，窗口越短越好；发完把这两个键改回注释掉，免得下一次静默发布
   变成每次都弹提示。

默认的静默发布只适用于向后兼容的改动。前端这边 `openConversation` 现在只在 404 / 403 时忘掉
会话，其它失败会留着会话并报一句「这个会话读不回来」——那是兜底，不是可以静默拆协议的理由。

## 十、回滚

```sh
d=~/.config/ai-image-playground/apps/<project>
cp -a $d/operator-config.json.bak-agent-<ts> $d/operator-config.json
cp -a $d/app.env.bak-agent-<ts>              $d/app.env
cd <checkout> && ./scripts/app-compose.sh up <project>
```

只把 `agent:chat` 改回 `false` 也够：能力一关，路由整条拒绝，单价行与环境变量留着无害。

### Cached input settlement

The Agent SDK separates uncached input, cache reads and cache writes. The turn ledger restores
**total input** and also records `cachedInputTokens` (cache reads only). Output already includes
reasoning tokens. Do not add reasoning again or charge cache hits both as ordinary and cached input.

The private price row provides `cachedInputPriceRatio`. Settlement weights total input minus cache
reads at the ordinary rate, reads at that ratio, and output at its configured ratio. Cache writes
remain ordinary input under this product policy. Sum the whole turn before the existing integer-credit
rounding. Precharge remains conservative because cache hits are unknown before execution.

Overlay migration `0012_cached_input_pricing` adds the operator's 0–100% cached input rate and
settled cache counters. Default 0 preserves legacy deployments that did not bill cache reads;
configure each model explicitly before claiming a paid cache rate. The operator-approved rollout
sets Luna, Sol and Astra to 1 / 0.1 / 5 credits per thousand ordinary input / cache-read / output tokens.
Changing other fields through an older admin preserves the cached rate. Existing turns keep their
captured pricing; historical tasks are not rebilled.

A turn with only cached input still has known usage. If any conversation call lacks usage, the turn
must not expose partial totals as complete or calculate a refund from them; existing reservation
fallback applies. Individual call records remain available for diagnosis.
