import { describe, expect, it } from 'vitest';
import { buildDashboardFallback, buildDashboardViewModel, formatDashboardUpdatedAt } from '../src/dashboardMetrics.js';

const tickets = [
  { status: 'waiting', category: 'general', issuedAt: '2026-10-25T01:00:00.000Z', currentPoint: 1 },
  { status: 'called', category: 'emergency', issuedAt: '2026-10-25T02:00:00.000Z', calledAt: '2026-10-25T02:10:00.000Z', currentPoint: 3 },
  { status: 'completed', category: 'general', issuedAt: '2026-10-25T03:00:00.000Z', calledAt: '2026-10-25T03:05:00.000Z', completedAt: '2026-10-25T03:25:00.000Z', currentPoint: 6 },
  { status: 'skipped', category: 'general', issuedAt: 'invalid', currentPoint: 7 },
  { status: 'cancelled', category: 'general', currentPoint: 4 },
];

describe('dashboard metrics', () => {
  it('builds totals, averages, hourly data and station fallbacks', () => {
    const fallback = buildDashboardFallback(tickets);
    expect(fallback).toMatchObject({ total: 5, waiting: 1, calling: 1, completed: 1, skipped: 1, cancelled: 1, emergency: 1, averageWaitMinutes: 8, averageServiceMinutes: 20 });
    expect(fallback.hourly).toHaveLength(12);
    const view = buildDashboardViewModel(null, tickets);
    expect(view.bars).toHaveLength(5);
    expect(view.bars.find(item => item.label === 'จุดบริการ 1').users).toBe(1);
    expect(view.peakMax).toBeGreaterThanOrEqual(1);
  });

  it('normalizes supplied stations and special labels', () => {
    const view = buildDashboardViewModel({
      stations: [{ station: 'ไม่ระบุ', served: 10, averageWaitMinutes: 8, averageServiceMinutes: 4 }],
      hourly: [{ hour: 9, users: 3 }],
    });
    expect(view.bars[0]).toMatchObject({ label: 'ไม่ระบุจุดบริการ', users: 10, usersHeight: 100, waitHeight: 100, minutesHeight: 100 });
    expect(view.peakMax).toBe(3);
  });

  it('formats update timestamps and handles an empty value', () => {
    expect(formatDashboardUpdatedAt()).toBeNull();
    expect(formatDashboardUpdatedAt('2026-10-25T08:00:00.000Z')).toContain('25');
  });
});
