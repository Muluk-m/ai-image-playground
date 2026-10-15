import { sql } from 'drizzle-orm'

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
        THEN MIN(substring(related.message from 'connIndex=([0-9]+)')) END AS conn_index, MAX(related.at) AS warning_at
      FROM server_logs related
      WHERE errors.source = 'server' AND errors.service = 'cloudflared'
        AND errors.message LIKE '%failed to serve incoming request error="Error shutting down control stream:%'
        AND related.service = errors.service AND related.instance = errors.instance
        AND related.at BETWEEN errors.at - interval '1 second' AND errors.at + interval '2 seconds'
        AND related.at <= ${new Date(now)}
        AND related.message LIKE '% WRN Serve tunnel error %'
        AND substring(related.message from 'error="([^"]+)"') = substring(errors.message from 'error="([^"]+)"')
    ) connection ON true
    LEFT JOIN LATERAL (
      SELECT registered.at FROM server_logs registered
      WHERE connection.conn_index IS NOT NULL
        AND registered.service = 'cloudflared' AND registered.instance = errors.instance
        AND registered.at > GREATEST(errors.at, connection.warning_at) AND registered.at <= ${new Date(now)}
        AND registered.message LIKE '% INF Registered tunnel connection %'
        AND substring(registered.message from 'connIndex=([0-9]+)') = connection.conn_index
      ORDER BY registered.at ASC, registered.id ASC LIMIT 1
    ) reconnected ON true
  `
}
