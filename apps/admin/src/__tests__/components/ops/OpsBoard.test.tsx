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

const { OpsBoard } = await import('../../../components/ops/OpsBoard')

const minute = 60_000
const hour = 60 * minute
const NOW = Date.now()

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
          modified_at: NOW - 3 * hour,
        },
        previous: {
          key: 'pg/2026-09-16.dump',
          size_bytes: 41 * 1024 ** 2,
          modified_at: NOW - 27 * hour,
        },
      },
    },
    ...patch,
  }
}

function block(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

describe('运维看板', () => {
  it('没事的时候一眼看得出没事：没有任何一块在报警', () => {
    render(<OpsBoard snapshot={snapshot()} />)

    expect(screen.queryAllByRole('alert')).toEqual([])
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
    const alert = within(block('队列')).getByRole('alert')
    expect(alert.textContent).toContain('12 分钟')
    expect(within(block('数据库')).queryByRole('alert')).toBeNull()
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
    expect(within(queue).getByRole('alert').textContent).toContain('1 个任务卡住')
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
    expect(within(backup).getByText('3 小时前')).toBeTruthy()
    expect(within(backup).queryByRole('alert')).toBeNull()
  })

  it('超过 26 小时没有新备份就报警', () => {
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
    expect(within(block('备份')).getByRole('alert').textContent).toContain('2 天 2 小时')
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
    expect(within(block('备份')).getByRole('alert').textContent).toContain('比前一份小')
  })

  it('一份备份都还没有时照实说，也算要处理的事', () => {
    render(
      <OpsBoard
        snapshot={snapshot({ backup: { ok: true, data: { latest: null, previous: null } } })}
      />,
    )
    expect(within(block('备份')).getByRole('alert').textContent).toContain('还没有备份')
  })

  it('服务一栏说清谁活着、跑的是哪个版本、worker 是不是真的在干活', () => {
    render(<OpsBoard snapshot={snapshot()} />)
    const services = block('服务')
    expect(within(services).getAllByText('ae5da35c')).toHaveLength(2)
    expect(within(services).getByText('12 秒前')).toBeTruthy()
    expect(within(services).getByText(/最后一次成功轮询/).textContent).toContain('刚刚')
    expect(within(services).queryByRole('alert')).toBeNull()
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
    const alert = within(block('服务')).getByRole('alert').textContent ?? ''
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
    expect(within(block('服务')).getByRole('alert').textContent).toContain('版本不一致')
  })
})
