# Domain cutover

**切换是一次性的，只有一个方向。** 旧域名对前端文档路径配一条 301 指向新域名；代码里**没有任何**
把访客送回旧域名的路径。送回去只会撞上那条 301 再弹回来，来回切一次都不该发生。

Browser data is copied directly from the source origin's `/local-compat.html` through a
checked-origin MessageChannel before the application opens IndexedDB. Each acknowledgement
follows a committed destination transaction. Source databases are never deleted. Existing
conflicts are backed up locally and a conflicting source canvas is kept as a separate
旧站画布 project, so an unresolved import still mounts the app on the target origin. A full
but unresolved pass is recorded once so the next visit does not re-stream the whole library.

Login continuity uses top-level HTTPS API navigations, because the source's SameSite=Lax
session cookie cannot be read inside a cross-site iframe. Both API hosts must reach the same
BFF process and database. Set `DOMAIN_HANDOFF_CONFIG_FILE` to a mounted JSON file containing
`sourceOrigin`, `targetOrigin`, `sourceApiOrigin`, and `targetApiOrigin` (bare HTTPS origins).
The configuration is validated at startup; without it the handoff is disabled.

The exchange binding cookie carries the `__Host-` prefix, so no sibling host under the API's
registrable domain can overwrite it; that cookie is the only thing tying a redemption to the
browser that started it. Before enabling the handoff, check that `CLIENT_IP_SOURCE` identifies
the visitor (`cf-connecting-ip` behind Cloudflare) and not the reverse proxy — the start
endpoint's throughput budget is per address, and a collapsed address budget leaves every
visitor to sign in by hand. The routes are additionally gated on the `accounts:login`
capability: with accounts disabled the handoff reports itself unavailable instead of minting
sessions.

The target API binds a two-minute, single-use exchange to an HttpOnly cookie. The source API
identifies its existing session; the target API revalidates the active user and unexpired
source session, creates a new session capped to the source expiry, and issues its normal
HttpOnly cookie. Existing target accounts are preserved. No cookie credential or browser
storage payload is handed to frontend JavaScript. Only temporary authentication metadata
is held in process memory; a restart drops in-flight exchanges and the visitor signs in by
hand. A separate short-lived HttpOnly completion receipt prevents query parameters from
pretending the exchange succeeded.

Deploy the BFF and configuration before the frontend. Keep the per-origin API mapping so the
source origin's own pages keep using the source API and its cookies while it still serves the
migration endpoints. The frontend records successful handoff once; it must not silently sign
the user back in after an intentional logout.

**交接失败也留在新域名。** 本地导入没解决、目标 API 慢或挂、部署没开登录（`/api/auth/me` 答
404）、交接被关闭、限速预算用完、在途流程因重启丢失——一律正常挂载新站，访客手动登一次。
服务端放弃时下发一个两分钟的 `__Host-image_playground_domain_cooldown`，期间 `available` 报
`enabled:false`，免得前端「可用就发起 start」和放弃跳转形成回环；两分钟后照常再试。

## Redirect rollout

旧域名对**前端文档路径**（`/`、`/index.html`、`/p/*`）配 301 指向新域名同路径，保留 path 与
query。`/local-compat.html`、`/assets/*`、runtime config、其它资源与旧 API 都不在这条规则里：
导入要从旧 origin 读 `/local-compat.html`，登录交接要用旧 API 的 cookie。

保留旧域名的 DNS、HTTPS、Pages 与 API 服务：还没回来过的用户仍然需要原来的浏览器 origin 来搬
数据。回滚就是停掉这条规则；本次切换不删数据、不做数据库迁移。全路径重定向或直接下线旧站会切断
搬迁通道，即使大部分活跃用户已经迁完也不安全。
