import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock('../src/api.js', () => ({
  apiConfig: { url: '/api', configured: true },
  apiRequest,
  demoQueue: () => ({ tickets: [{ id: 'demo', ticketCode: 'Q001' }] }),
}));

import { useDashboardMetrics } from '../src/hooks/useDashboardMetrics.js';
import { useQueueData } from '../src/hooks/useQueueData.js';

describe('data hooks', () => {
  beforeEach(() => apiRequest.mockReset());
  afterEach(cleanup);

  it('loads and refreshes queue data', async () => {
    apiRequest.mockResolvedValue({ tickets: [{ id: 1, ticketCode: 'Q010' }] });
    const { result } = renderHook(() => useQueueData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.queue.tickets[0].ticketCode).toBe('Q010');
    expect(result.current.error).toBe('');
    await act(() => result.current.refresh());
    expect(apiRequest).toHaveBeenCalledWith('getQueue');
  });

  it('uses demonstration data when loading the queue fails', async () => {
    apiRequest.mockResolvedValue({ tickets: [] });
    const { result } = renderHook(() => useQueueData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    apiRequest.mockRejectedValueOnce(new Error('ฐานข้อมูลไม่พร้อม'));
    await act(() => result.current.refresh());
    expect(result.current.error).toBe('ฐานข้อมูลไม่พร้อม');
    expect(result.current.queue.tickets).toEqual([]);
  });

  it('loads dashboard aggregates and supports manual refresh', async () => {
    apiRequest.mockResolvedValue({ total: 12, waiting: 3 });
    const filters = { period: 'year', year: 2025 };
    const { result } = renderHook(() => useDashboardMetrics(filters));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.metrics.total).toBe(12);
    await act(() => result.current.refresh());
    expect(apiRequest).toHaveBeenCalledWith('getDashboard', { period: 'year', start: '', end: '', year: 2025 });
  });

  it('exposes dashboard request failures', async () => {
    apiRequest.mockResolvedValue({ total: 0 });
    const { result } = renderHook(() => useDashboardMetrics());
    await waitFor(() => expect(result.current.loading).toBe(false));
    apiRequest.mockRejectedValueOnce(new Error('โหลดสถิติไม่ได้'));
    await act(() => result.current.refresh());
    expect(result.current.error).toBe('โหลดสถิติไม่ได้');
    expect(result.current.metrics.total).toBe(0);
  });
});
