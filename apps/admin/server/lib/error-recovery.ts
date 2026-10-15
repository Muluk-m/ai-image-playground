import { sql } from 'drizzle-orm'

/** Parse reconnect records once per window, including when many errors have no later success. */
export function tunnelRecoveryEvents(from: Date, now: number) {
  return sql`tunnel_reconnections AS MATERIALIZED (
    SELECT instance, at, id, substring(message from 'connIndex=([0-9]+)') AS conn_index
    FROM server_logs
    WHERE service = 'cloudflared' AND at >= ${from} AND at <= ${new Date(now)}
      AND message LIKE '% INF Registered tunnel connection %'
  )`
}

/** Recovery requires the same task or tunnel connection; silence and unrelated successes prove nothing. */
export function errorRecoveryJoins(now: number) {
  return sql`
    LEFT JOIN queue_tasks task ON errors.source = 'server' AND task.id = errors.task_id
      AND errors.event IN ('task.failed', 'task.crashed', 'generation.failed')
      AND task.submitted_at <= errors.at
      AND ((task.status = 'completed' AND task.completed_at >= errors.at AND task.completed_at <= ${new Date(now)})
        OR (task.status = 'failed' AND (task.completed_at IS NULL OR task.completed_at <= ${new Date(now)})))
    LEFT JOIN LATERAL (
      -- HTTP/2's control-stream ERR omits connIndex. Its adjacent warning supplies it.
      -- Concurrent warnings for different connections are ambiguous and stay unknown.
      SELECT CASE WHEN COUNT(DISTINCT substring(related.message from 'connIndex=([0-9]+)')) = 1
        THEN MIN(substring(related.message from 'connIndex=([0-9]+)')) END AS conn_index, MAX(related.at) AS warning_at,
        BOOL_OR(substring(related.message from 'error="([^"]+)"') = 'connection with edge closed') AS needs_edge_loss
      FROM server_logs related
      WHERE errors.source = 'server' AND errors.service = 'cloudflared'
        AND errors.message LIKE '%failed to serve incoming request error="Error shutting down control stream:%'
        AND related.service = errors.service AND related.instance = errors.instance
        AND related.at BETWEEN errors.at - interval '1 second' AND errors.at + interval '2 seconds'
        AND related.at <= ${new Date(now)}
        AND related.message LIKE '% WRN Serve tunnel error %'
        AND (
          substring(related.message from 'error="([^"]+)"') = substring(errors.message from 'error="([^"]+)"')
          OR (
            -- Edge loss uses different control-stream and tunnel errors.
            substring(errors.message from 'error="([^"]+)"') = 'Error shutting down control stream: client disconnected'
            AND substring(related.message from 'error="([^"]+)"') = 'connection with edge closed'
          )
        )
    ) connection ON true
    LEFT JOIN LATERAL (
      -- Check loss evidence only after resolving ambiguity across all candidate warnings.
      SELECT MAX(lost.at) AS at FROM server_logs lost
      WHERE connection.needs_edge_loss AND connection.conn_index IS NOT NULL
        AND lost.service = 'cloudflared' AND lost.instance = errors.instance
        AND lost.at BETWEEN errors.at - interval '1 second' AND errors.at + interval '2 seconds'
        AND lost.at <= ${new Date(now)}
        AND lost.message LIKE '% INF Lost connection with the edge %'
        AND substring(lost.message from 'connIndex=([0-9]+)') = connection.conn_index
    ) edge_loss ON true
    LEFT JOIN LATERAL (
      SELECT registered.at FROM tunnel_reconnections registered
      WHERE connection.conn_index IS NOT NULL
        AND registered.instance = errors.instance
        AND (NOT connection.needs_edge_loss OR edge_loss.at IS NOT NULL)
        AND registered.at > GREATEST(errors.at, connection.warning_at, edge_loss.at)
        AND registered.conn_index = connection.conn_index
      ORDER BY registered.at ASC, registered.id ASC LIMIT 1
    ) reconnected ON true
  `
}
