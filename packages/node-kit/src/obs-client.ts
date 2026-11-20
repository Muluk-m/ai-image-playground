/**
 * 经 OpenObserve 只读代理查日志和链路（ADR 0033）。`scripts/obs.ts`、Admin 与 BFF 共用。
 * SQL 的拼装在 `@image-playground/shared` 的 obs-query 里，这里只管请求、鉴权、超时和分页。
 */

/** OpenObserve `_search` 返回的一条记录（日志或 span）。 */
export type ObsRecord = Record<string, unknown>

export interface ObsConnection {
  /** 代理地址，不带末尾斜杠，例如 `http://obs-proxy:5090`。 */
  readonly url: string
  /** 代理的 `OBS_PROXY_TOKEN`。 */
  readonly token: string
  readonly org: string
}

export type ObsQueryFailure = 'unreachable' | 'unauthorized' | 'timeout' | 'failed'

export class ObsQueryError extends Error {
  constructor(
    readonly failure: ObsQueryFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ObsQueryError'
  }
}

/**
 * 服务内的连接配置：`OBS_PROXY_URL` 与 `OBS_PROXY_TOKEN` 都有才算配了观测；任一缺失返回 null，
 * 调用方据此显示「未配置」（测试环境不开 OpenObserve）。
 */
export function obsConnectionFromEnv(
  env: Record<string, string | undefined> = process.env,
): ObsConnection | null {
  let url = env.OBS_PROXY_URL?.trim() ?? ''
  while (url.endsWith('/')) url = url.slice(0, -1)
  const token = env.OBS_PROXY_TOKEN?.trim()
  if (!url || !token) return null
  return { url, token, org: env.OBS_ORG?.trim() || 'default' }
}

export interface ObsSearch {
  readonly sql: string
  readonly type?: 'logs' | 'traces'
  /** 查询时间段，毫秒时间戳。OpenObserve 按它裁剪分区，必须给。 */
  readonly startMs: number
  readonly endMs: number
  readonly from?: number
  readonly size?: number
}

export type ObsFetch = (input: string, init?: RequestInit) => Promise<Response>

export interface ObsClientOptions {
  readonly fetch?: ObsFetch
  readonly timeoutMs?: number
}

export interface ObsClient {
  search(query: ObsSearch): Promise<ObsRecord[]>
  /** 按页拉全：一页 `pageSize` 条，最多 `maxPages` 页；到顶时 `truncated` 为 true。 */
  searchAll(
    query: Omit<ObsSearch, 'from' | 'size'>,
    paging?: { pageSize?: number; maxPages?: number },
  ): Promise<{ records: ObsRecord[]; truncated: boolean }>
}

export function createObsClient(
  connection: ObsConnection,
  options: ObsClientOptions = {},
): ObsClient {
  const fetcher: ObsFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const timeoutMs = options.timeoutMs ?? 60_000

  async function search(query: ObsSearch): Promise<ObsRecord[]> {
    const body = JSON.stringify({
      query: {
        sql: query.sql,
        start_time: Math.floor(query.startMs * 1_000),
        end_time: Math.ceil(query.endMs * 1_000),
        from: query.from ?? 0,
        size: query.size ?? 1_000,
      },
    })
    let response: Response
    try {
      response = await fetcher(
        `${connection.url}/api/${encodeURIComponent(connection.org)}/_search?type=${query.type ?? 'logs'}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.token}`,
            'content-type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        },
      )
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (name === 'TimeoutError')
        throw new ObsQueryError('timeout', `查询超过 ${timeoutMs / 1_000} 秒没有返回`)
      throw new ObsQueryError(
        'unreachable',
        `连不上 ${connection.url}：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    // fetch 在收到响应头时就返回：正文读到一半超时、断开或不是 JSON，都是查询失败，不能当成没有结果。
    let payload: { hits?: unknown; message?: unknown; error?: unknown }
    try {
      payload = (await response.json()) as typeof payload
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (name === 'TimeoutError' || name === 'AbortError')
        throw new ObsQueryError('timeout', `查询超过 ${timeoutMs / 1_000} 秒没有返回`)
      if (response.status === 401)
        throw new ObsQueryError('unauthorized', '观测代理拒绝了令牌', response.status)
      if (!response.ok)
        throw new ObsQueryError('failed', `查询失败（${response.status}）`, response.status)
      throw new ObsQueryError('failed', '观测代理返回的结果读不出来', response.status)
    }
    if (!response.ok) {
      // 还没有任何数据写进来时流不存在：当作没结果。
      if (/stream not found/i.test(String(payload.message))) return []
      if (response.status === 401)
        throw new ObsQueryError('unauthorized', '观测代理拒绝了令牌', response.status)
      const reason = payload.message ?? payload.error ?? '未知错误'
      throw new ObsQueryError(
        'failed',
        `查询失败（${response.status}）：${String(reason)}`,
        response.status,
      )
    }
    if (!Array.isArray(payload.hits))
      throw new ObsQueryError('failed', '观测代理返回的结果缺少 hits', response.status)
    return payload.hits as ObsRecord[]
  }

  async function searchAll(
    query: Omit<ObsSearch, 'from' | 'size'>,
    { pageSize = 1_000, maxPages = 20 }: { pageSize?: number; maxPages?: number } = {},
  ): Promise<{ records: ObsRecord[]; truncated: boolean }> {
    const records: ObsRecord[] = []
    for (let page = 0; page < maxPages; page++) {
      const hits = await search({ ...query, from: page * pageSize, size: pageSize })
      records.push(...hits)
      if (hits.length < pageSize) return { records, truncated: false }
    }
    return { records, truncated: true }
  }

  return { search, searchAll }
}
