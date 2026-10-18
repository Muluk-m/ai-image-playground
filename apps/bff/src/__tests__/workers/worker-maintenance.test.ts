import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

// Import the real worker entrypoint in a child so its process listeners and module mocks stay isolated.
describe('worker deployment readiness', () => {
  it('keeps the health drain unsafe until in-progress private maintenance finishes', async () => {
    const source = resolve(import.meta.dir, '../..')
    const child = String.raw`
import { mock } from 'bun:test';
const root = process.env.WORKER_SOURCE;
const path = name => root + '/' + name;
const noop = () => {};
const done = async () => {};
const config = { assertValid: noop, worker: {
  startPaused: false, healthPort: 0, healthStaleAfterMs: 1000,
  pollIntervalMs: 1000, concurrency: { openaiCompat: 1, gemini: 1 }, drainTimeoutMs: 100
}};
mock.module(path('config.ts'), () => ({ config }));
mock.module(path('db/client.ts'), () => ({ close: done }));
mock.module(path('db/maintenance.ts'), () => ({ purgeOldHostSamples: done, recoverAbandonedTasks: done, recoverTasksByIds: done }));
mock.module(path('lib/analysis-tasks.ts'), () => ({ recoverAnalysisTasks: done }));
mock.module(path('lib/capabilities.ts'), () => ({ isCapabilityEnabled: () => false }));
mock.module(path('lib/channels.ts'), () => ({ initChannels: () => ({ warnings: [] }) }));
mock.module(path('lib/heartbeat.ts'), () => ({ purgeStaleHeartbeats: done, startHeartbeat: () => noop }));
mock.module(path('lib/logger.ts'), () => ({ log: { warn: noop, error: noop, info: noop, flush: noop } }));
mock.module(path('lib/server-logs.ts'), () => ({ startServerLogs: () => done }));
mock.module(path('ops/alert-sender.ts'), () => ({ createAlertSender: () => done }));
mock.module(path('ops/app-alerts.ts'), () => ({ createAppAlerting: () => done }));
mock.module(path('workers/analysis-runner.ts'), () => ({ abortAllRunningAnalysisTasks: noop, runningAnalysisTaskIds: () => [] }));
mock.module(path('workers/task-execution.ts'), () => ({ abortAllRunningTasks: noop, runningTaskIds: () => [] }));
let finishMaintenance;
const maintenance = new Promise(resolve => { finishMaintenance = resolve; });
mock.module(path('lib/private-overlay.ts'), () => ({
  assertPrivateBffOverlayPresent: noop,
  loadPrivateBffOverlay: async () => ({ taskHooks: { runWorkerMaintenance: () => maintenance } })
}));
class TaskScheduler {
  draining = false;
  start() {}
  stop() {}
  drain() { this.draining = true; }
  resume() { this.draining = false; }
  drainStatus() { return { draining: this.draining, active: 0, safeToStop: this.draining }; }
  lastSuccessfulPollAt() { return Date.now(); }
  activeCount() { return 0; }
  async waitForIdle() { return true; }
}
mock.module(path('workers/task-scheduler.ts'), () => ({ TaskScheduler }));
const health = await import(path('workers/worker-health.ts'));
const startWorkerHealthServer = health.startWorkerHealthServer;
let server;
mock.module(path('workers/worker-health.ts'), () => ({
  startWorkerHealthServer: options => { server = startWorkerHealthServer(options); return server; }
}));
let maintenanceTick;
const interval = globalThis.setInterval;
globalThis.setInterval = (callback, delay, ...args) => {
  if (delay === 15000) maintenanceTick = () => callback(...args);
  const timer = interval(noop, 1000000000);
  timer.unref();
  return timer;
};
await import(path('worker-index.ts'));
maintenanceTick();
await Promise.resolve();
const url = new URL('/internal/deployment/drain', server.url);
const pending = await (await fetch(url, { method: 'POST' })).json();
finishMaintenance();
await maintenance;
const settled = await (await fetch(url)).json();
await server.stop(true);
console.log(JSON.stringify({ pending, settled }));
process.exit(0);
`
    const proc = Bun.spawn([process.execPath, '-e', child], {
      env: { ...process.env, WORKER_SOURCE: source },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => proc.kill(), 10_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
      const status = JSON.parse(stdout)
      expect(status.pending).toEqual({
        draining: true,
        active: 0,
        safeToStop: false,
        maintenanceActive: true,
      })
      expect(status.settled).toEqual({
        draining: true,
        active: 0,
        safeToStop: true,
        maintenanceActive: false,
      })
    } finally {
      clearTimeout(timer)
    }
  }, 15_000)
})
