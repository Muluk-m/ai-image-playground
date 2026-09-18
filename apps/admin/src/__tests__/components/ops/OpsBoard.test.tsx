// @vitest-environment jsdom

import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OpsSnapshot } from '../../../lib/types'

// 任务详情是一条路由链接；这里只关心它指向哪，不需要起整棵路由树。
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, params }: { children: React.ReactNode; params: { taskId: string } }) => (
    <a href={`/tasks/${params.taskId}`}>{children}</a>
  ),
}))

vi.mock('../../../components/ops/LazyHostTrendChart', () => ({
  LazyHostTrendChart: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}))
vi.mock('../../../components/ops/LazyApiTrendChart', () => ({
  LazyApiTrendChart: ({ label }: { label: string }) => <div role="img" aria-label={label} />,
}))

const { OpsBoard } = await import('../../../components/ops/OpsBoard')

const minute = 60_000
const hour = 60 * minute
const NOW = Date.now()
const GB = 1024 ** 3

function snapshot(patch: Partial<OpsSnapshot> = {}): OpsSnapshot {
  return {
    generated_at: NOW,
    queue: {
      ok: true,
      data: {
        queued: 2,
        in_progress: 1,
        oldest_queued_wait_ms: 4_000,
        stale_after_ms: 16 * minute,
        stuck: [],
      },
    },
    database: {
      ok: true,
      data: {
        size_bytes: 3 * 1024 ** 3,
        tables: [
          { name: 'tasks', bytes: 2 * 1024 ** 3 },
          { name: 'agent_turn_events', bytes: 512 * 1024 ** 2 },
        ],
      },
    },
    host: {
      ok: true,
      data: {
        latest: {
          sampled_at: NOW - 40_000,
          disk_total_bytes: 50 * GB,
          disk_available_bytes: 18 * GB,
          mem_total_bytes: 4 * GB,
          mem_available_bytes: 1.5 * GB,
        },
        series: [
          {
            at: NOW - 2 * hour,
            disk_used_ratio: 0.6,
            mem_available_ratio: 0.4,
            cpu_busy_ratio: 0.2,
          },
          { at: NOW - hour, disk_used_ratio: 0.64, mem_available_ratio: 0.38, cpu_busy_ratio: 0.3 },
        ],
      },
    },
    services: {
      ok: true,
      data: {
        services: [
          {
            service: 'bff',
            instance: 'b1',
            version: 'ae5da35c',
            last_seen_at: NOW - 12_000,
            last_successful_poll_at: null,
          },
          {
            service: 'worker',
            instance: 'w1',
            version: 'ae5da35c',
            last_seen_at: NOW - 8_000,
            last_successful_poll_at: NOW - 2_000,
          },
        ],
      },
    },
    backup: {
      ok: true,
      data: {
        latest: {
          key: 'pg/2026-09-17.dump',
          size_bytes: 42 * 1024 ** 2,
          modified_at: NOW - hour,
        },
        previous: {
          key: 'pg/2026-09-16.dump',
          size_bytes: 41 * 1024 ** 2,
          modified_at: NOW - 27 * hour,
        },
      },
    },
    containers: {
      ok: true,
      data: {
        sampled_at: NOW - 40_000,
        containers: [
          {
            container_id: 'a'.repeat(64),
            name: 'image-playground-infra-postgres-1',
            mem_bytes: 400 * 1024 ** 2,
            mem_limit_bytes: null,
            cpu_cores: 0.05,
            oom_kills: 0,
            peak_mem_bytes: 900 * 1024 ** 2,
            recent_oom_kills: 0,
          },
          {
            container_id: 'b'.repeat(64),
            name: null,
            mem_bytes: 100 * 1024 ** 2,
            mem_limit_bytes: 512 * 1024 ** 2,
            cpu_cores: null,
            oom_kills: 0,
            peak_mem_bytes: 100 * 1024 ** 2,
            recent_oom_kills: 0,
          },
        ],
      },
    },
    api: {
      ok: true,
      data: {
        recent: { requests: 300, client_errors: 4, server_errors: 1, p95_ms: 420 },
        window_ms: 15 * minute,
        series: [
          { at: NOW - hour, requests: 200, server_errors: 0, p95_ms: 300 },
          { at: NOW - 45 * minute, requests: 300, server_errors: 1, p95_ms: 420 },
        ],
        error_routes: [{ route: 'POST /v1/queue/:provider/:model/submit', count: 1 }],
      },
    },
    deployments: {
      ok: true,
      data: {
        own: 'paid',
        available: true,
        entries: [
          {
            at: NOW - 2 * hour,
            target: 'paid',
            public_sha: '586302544693b2fb261269ff0b18a77d8f8f76df',
            private_sha: '79fc8056986651efcd4f8dc8f804319b953a4688',
            image: 'ai-image-playground:paid-586302544693-79fc80569866',
            by: 'ubuntu@vps',
            ok: true,
          },
          {
            at: NOW - 3 * hour,
            target: 'internal',
            public_sha: '39d2cf1c',
            private_sha: null,
            image: 'ai-image-playground:vps-main-39d2cf1c',
            by: 'ubuntu@vps',
            ok: false,
          },
        ],
      },
    },
    ...patch,
  }
}

function hostLatest(
  patch: Partial<NonNullable<Extract<OpsSnapshot['host'], { ok: true }>['data']['latest']>>,
) {
  const base = snapshot().host
  if (!base.ok || !base.data.latest) throw new Error('fixture')
  return { ok: true as const, data: { ...base.data, latest: { ...base.data.latest, ...patch } } }
}

function block(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

describe('运维看板', () => {
  it('没事的时候一眼看得出没事：没有任何一块在报警', () => {
    render(<OpsBoard snapshot={snapshot()} />)

    expect(screen.queryAllByRole('list', { name: '需要处理' })).toEqual([])
    expect(within(block('队列')).getByText('2')).toBeTruthy()
    expect(within(block('队列')).getByText('4 秒')).toBeTruthy()
    expect(within(block('数据库')).getByText('3.0 GB')).toBeTruthy()
    expect(within(block('数据库')).getByText('tasks')).toBeTruthy()
  })

  it('队列为空时不把「没有在等的任务」显示成 0 秒', () => {
    render(
      <OpsBoard
        snapshot={snapshot({
          queue: {
            ok: true,
            data: {
              queued: 0,
              in_progress: 0,
              oldest_queued_wait_ms: null,
              stale_after_ms: 16 * minute,
              stuck: [],
            },
          },
        })}
      />,
    )
    expect(within(block('队列')).getByText('没有在等的任务')).toBeTruthy()
  })

  it('最老的任务等得太久时，队列这一块报警', () => {
    render(
      <OpsBoard
        snapshot={snapshot({
          queue: {
            ok: true,
            data: {
              queued: 9,
              in_progress: 1,
              oldest_queued_wait_ms: 12 * minute,
              stale_after_ms: 16 * minute,
              stuck: [],
            },
          },
        })}
      />,
    )
    const alert = within(block('队列')).getByRole('list', { name: '需要处理' })
    expect(alert.textContent).toContain('12 分钟')
    expect(within(block('数据库')).queryByRole('list', { name: '需要处理' })).toBeNull()
  })

  it('卡住的任务列出来，能点进任务详情', () => {
    render(
      <OpsBoard
        snapshot={snapshot({
          queue: {
            ok: true,
            data: {
              queued: 0,
              in_progress: 1,
              oldest_queued_wait_ms: null,
              stale_after_ms: 16 * minute,
              stuck: [
                { id: 'task-stuck-1', model: 'gpt-image-2', started_at: Date.now() - 20 * minute },
              ],
            },
          },
        })}
      />,
    )
    const queue = block('队列')
    expect(within(queue).getByRole('list', { name: '需要处理' }).textContent).toContain(
      '1 个任务运行超过',
    )
    const link = within(queue).getByRole('link', { name: /task-stuck-1/ })
    expect(link.getAttribute('href')).toBe('/tasks/task-stuck-1')
  })

  it('某一块取不到时只有那一块显示取不到，其余照常', () => {
    render(
      <OpsBoard snapshot={snapshot({ database: { ok: false, error: 'permission denied' } })} />,
    )

    expect(within(block('数据库')).getByText('取不到')).toBeTruthy()
    expect(within(block('数据库')).getByText('permission denied')).toBeTruthy()
    expect(within(block('队列')).getByText('4 秒')).toBeTruthy()
  })

  it('备份一栏说清最新一份是哪天的、多大、多久之前', () => {
    render(<OpsBoard snapshot={snapshot()} />)
    const backup = block('备份')
    expect(within(backup).getByText('2026-09-17')).toBeTruthy()
    expect(within(backup).getByText('42.0 MB')).toBeTruthy()
    expect(within(backup).getByText('1 小时前')).toBeTruthy()
    expect(within(backup).queryByRole('list', { name: '需要处理' })).toBeNull()
  })

  it('超过 2 小时没有新备份就报警', () => {
    render(
      <OpsBoard
        snapshot={snapshot({
          backup: {
            ok: true,
            data: {
              latest: {
                key: 'pg/2026-09-15.dump',
                size_bytes: 42 * 1024 ** 2,
                modified_at: NOW - 50 * hour,
              },
              previous: null,
            },
          },
        })}
      />,
    )
    expect(within(block('备份')).getByRole('list', { name: '需要处理' }).textContent).toContain(
      '2 天 2 小时',
    )
  })

  it('最新一份比前一份小了一大半，多半是 dump 半途而废', () => {
    render(
      <OpsBoard
        snapshot={snapshot({
          backup: {
            ok: true,
            data: {
              latest: { key: 'pg/2026-09-17.dump', size_bytes: 8 * 1024, modified_at: NOW - hour },
              previous: {
                key: 'pg/2026-09-16.dump',
                size_bytes: 41 * 1024 ** 2,
                modified_at: NOW - 25 * hour,
              },
            },
          },
        })}
      />,
    )
    expect(within(block('备份')).getByRole('list', { name: '需要处理' }).textContent).toContain(
      '比前一份小',
    )
  })

  it('一份备份都还没有时照实说，也算要处理的事', () => {
    render(
      <OpsBoard
        snapshot={snapshot({ backup: { ok: true, data: { latest: null, previous: null } } })}
      />,
    )
    expect(within(block('备份')).getByRole('list', { name: '需要处理' }).textContent).toContain(
      '还没有备份',
    )
  })

  it('服务一栏说清谁活着、跑的是哪个版本、worker 是不是真的在干活', () => {
    render(<OpsBoard snapshot={snapshot()} />)
    const services = block('服务')
    expect(within(services).getAllByText('ae5da35c')).toHaveLength(2)
    expect(within(services).getByText('12 秒前')).toBeTruthy()
    expect(within(services).getByText(/最后一次成功轮询/).textContent).toContain('刚刚')
    expect(within(services).queryByRole('list', { name: '需要处理' })).toBeNull()
  })

  it('心跳断了超过 2 分钟就报警，从没出现过的服务也算', () => {
    render(
      <OpsBoard
        snapshot={snapshot({
          services: {
            ok: true,
            data: {
              services: [
                {
                  service: 'bff',
                  instance: 'b1',
                  version: 'ae5da35c',
                  last_seen_at: NOW - 5 * minute,
                  last_successful_poll_at: null,
                },
              ],
            },
          },
        })}
      />,
    )
    const alert = within(block('服务')).getByRole('list', { name: '需要处理' }).textContent ?? ''
    expect(alert).toContain('后端的心跳已经断了 5 分钟')
    expect(alert).toContain('worker 还没有心跳')
  })

  it('两个服务版本不一致时提示，部署只滚了一半就是这个样子', () => {
    render(
      <OpsBoard
        snapshot={snapshot({
          services: {
            ok: true,
            data: {
              services: [
                {
                  service: 'bff',
                  instance: 'b1',
                  version: 'ae5da35c',
                  last_seen_at: NOW - 5_000,
                  last_successful_poll_at: null,
                },
                {
                  service: 'worker',
                  instance: 'w1',
                  version: '4943d1a9',
                  last_seen_at: NOW - 5_000,
                  last_successful_poll_at: NOW - 1_000,
                },
              ],
            },
          },
        })}
      />,
    )
    expect(within(block('服务')).getByRole('list', { name: '需要处理' }).textContent).toContain(
      '版本不一致',
    )
  })

  it('宿主机一栏给出磁盘和内存的现状与趋势', () => {
    render(<OpsBoard snapshot={snapshot()} />)
    const host = block('宿主机')
    expect(within(host).getByText('64%')).toBeTruthy()
    expect(within(host).getByText(/剩 18\.0 GB/)).toBeTruthy()
    expect(within(host).getByText('1.5 GB')).toBeTruthy()
    expect(within(host).getByRole('img', { name: /磁盘、内存与 CPU/ })).toBeTruthy()
    expect(within(host).queryByRole('list', { name: '需要处理' })).toBeNull()
  })

  it('磁盘用到 85% 就报警', () => {
    render(
      <OpsBoard
        snapshot={snapshot({
          host: {
            ok: true,
            data: {
              latest: {
                sampled_at: NOW - 40_000,
                disk_total_bytes: 50 * GB,
                disk_available_bytes: 5 * GB,
                mem_total_bytes: 4 * GB,
                mem_available_bytes: 1.5 * GB,
              },
              series: [],
            },
          },
        })}
      />,
    )
    expect(within(block('宿主机')).getByRole('list', { name: '需要处理' }).textContent).toContain(
      '磁盘已用 90%',
    )
  })

  it('采样断了就说曲线过期了，而不是让人对着旧数字放心', () => {
    render(
      <OpsBoard
        snapshot={snapshot({
          host: {
            ok: true,
            data: {
              latest: {
                sampled_at: NOW - 20 * minute,
                disk_total_bytes: 50 * GB,
                disk_available_bytes: 18 * GB,
                mem_total_bytes: 4 * GB,
                mem_available_bytes: 1.5 * GB,
              },
              series: [],
            },
          },
        })}
      />,
    )
    expect(within(block('宿主机')).getByRole('list', { name: '需要处理' }).textContent).toContain(
      '20 分钟没有新的采样',
    )
  })

  it('没启用采集容器时照实说未启用，不算出事', () => {
    render(
      <OpsBoard snapshot={snapshot({ host: { ok: true, data: { latest: null, series: [] } } })} />,
    )
    const host = block('宿主机')
    expect(within(host).getByText('未启用')).toBeTruthy()
    expect(within(host).queryByRole('list', { name: '需要处理' })).toBeNull()
  })

  it('宿主机一栏给出 CPU、负载、Swap 与开机时间', () => {
    render(
      <OpsBoard
        snapshot={snapshot({
          host: hostLatest({
            cpu_count: 2,
            cpu_busy_ratio: 0.35,
            load_1: 0.42,
            load_5: 0.34,
            load_15: 0.23,
            swap_total_bytes: 2 * GB,
            swap_free_bytes: 1.5 * GB,
            booted_at: NOW - 3 * 24 * hour,
          }),
        })}
      />,
    )
    const host = block('宿主机')
    expect(within(host).getByText('35%')).toBeTruthy()
    expect(within(host).getByText('2 核 · 负载 0.42 / 0.34 / 0.23')).toBeTruthy()
    expect(within(host).getByText('512.0 MB')).toBeTruthy()
    expect(within(host).getByText('3 天前')).toBeTruthy()
    expect(within(host).queryByRole('list', { name: '需要处理' })).toBeNull()
  })

  it('可用内存快见底、机器刚重启过，都写在最上面', () => {
    render(
      <OpsBoard
        snapshot={snapshot({
          host: hostLatest({ mem_available_bytes: 0.04 * GB, booted_at: NOW - 10 * minute }),
        })}
      />,
    )
    const alert = within(block('宿主机')).getByRole('list', { name: '需要处理' }).textContent ?? ''
    expect(alert).toContain('快要耗尽')
    expect(alert).toContain('前重启过')
  })

  it('容器一栏列出整台机器上的容器，没名字的用 ID 前 12 位', () => {
    render(<OpsBoard snapshot={snapshot()} />)
    const containers = block('容器')
    expect(within(containers).getByText('infra-postgres-1')).toBeTruthy()
    expect(within(containers).getByText('b'.repeat(12))).toBeTruthy()
    expect(within(containers).getByText('900.0 MB')).toBeTruthy()
    expect(within(containers).queryByRole('list', { name: '需要处理' })).toBeNull()
  })

  it('近 24 小时有容器被 OOM 杀过进程就报警', () => {
    const base = snapshot().containers
    if (!base.ok) throw new Error('fixture')
    render(
      <OpsBoard
        snapshot={snapshot({
          containers: {
            ok: true,
            data: {
              ...base.data,
              containers: [{ ...base.data.containers[0]!, oom_kills: 3, recent_oom_kills: 2 }],
            },
          },
        })}
      />,
    )
    expect(within(block('容器')).getByRole('list', { name: '需要处理' }).textContent).toContain(
      'infra-postgres-1 近 24 小时有 2 个进程因内存不足被内核杀掉',
    )
  })

  it('接口一栏给出最近的请求量、5xx 和延迟，并点名出错的接口', () => {
    render(<OpsBoard snapshot={snapshot()} />)
    const api = block('接口')
    expect(within(api).getByText('300')).toBeTruthy()
    expect(within(api).getByText('420 ms')).toBeTruthy()
    expect(within(api).getByText('POST /v1/queue/:provider/:model/submit')).toBeTruthy()
    // 300 个请求里 1 个 5xx，远低于 5%，不报警。
    expect(within(api).queryByRole('list', { name: '需要处理' })).toBeNull()
  })

  it('5xx 超过 5% 且请求数够多时报警；请求太少时不凭几次失败下结论', () => {
    const base = snapshot().api
    if (!base.ok) throw new Error('fixture')
    const { rerender } = render(
      <OpsBoard
        snapshot={snapshot({
          api: {
            ok: true,
            data: {
              ...base.data,
              recent: { ...base.data.recent, requests: 100, server_errors: 10 },
            },
          },
        })}
      />,
    )
    expect(within(block('接口')).getByRole('list', { name: '需要处理' }).textContent).toContain(
      '10% 的请求返回了 5xx',
    )

    rerender(
      <OpsBoard
        snapshot={snapshot({
          api: {
            ok: true,
            data: { ...base.data, recent: { ...base.data.recent, requests: 5, server_errors: 2 } },
          },
        })}
      />,
    )
    expect(within(block('接口')).queryByRole('list', { name: '需要处理' })).toBeNull()
  })

  it('部署记录标出本套，别套的失败不算本套出事', () => {
    render(<OpsBoard snapshot={snapshot()} />)
    const deployments = block('部署记录')
    expect(within(deployments).getByText('（本套）')).toBeTruthy()
    expect(within(deployments).getByText('58630254+79fc8056')).toBeTruthy()
    expect(within(deployments).getByText('失败')).toBeTruthy()
    expect(within(deployments).queryByRole('list', { name: '需要处理' })).toBeNull()
  })

  it('本套最近一次部署失败时报警', () => {
    const base = snapshot().deployments
    if (!base.ok) throw new Error('fixture')
    render(
      <OpsBoard
        snapshot={snapshot({
          deployments: {
            ok: true,
            data: { ...base.data, entries: [{ ...base.data.entries[0]!, ok: false }] },
          },
        })}
      />,
    )
    expect(within(block('部署记录')).getByRole('list', { name: '需要处理' }).textContent).toContain(
      '本套最近一次部署失败了',
    )
  })

  it('服务一栏的版本号截成 8 位，完整的放在悬停提示里', () => {
    const base = snapshot().services
    if (!base.ok) throw new Error('fixture')
    const version =
      '586302544693b2fb261269ff0b18a77d8f8f76df+79fc8056986651efcd4f8dc8f804319b953a4688'
    render(
      <OpsBoard
        snapshot={snapshot({
          services: {
            ok: true,
            data: { services: base.data.services.map((one) => ({ ...one, version })) },
          },
        })}
      />,
    )
    expect(within(block('服务')).getAllByText('58630254+79fc8056')).toHaveLength(2)
  })
})
