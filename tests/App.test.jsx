import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const reportMocks = vi.hoisted(() => ({
  downloadCsvReport: vi.fn(),
  downloadExcelReport: vi.fn(async () => {}),
  printReport: vi.fn(),
}));

vi.mock('../src/reportExport.js', () => reportMocks);

vi.mock('../src/hooks/useQueueData.js', () => ({
  useQueueData: () => ({
    queue: {
      tickets: [
        { id: 1, ticketCode: 'Q001', category: 'general', status: 'waiting', currentPoint: 1, sequenceNo: 1, issuedAt: '2026-10-25T01:00:00.000Z', arrivedAt: '2026-10-25T01:00:00.000Z' },
        { id: 2, ticketCode: 'Q002', category: 'general', status: 'called', currentPoint: 4, sequenceNo: 2, issuedAt: '2026-10-25T02:00:00.000Z', calledAt: '2026-10-25T02:10:00.000Z' },
        { id: 3, ticketCode: 'Q003', category: 'emergency', status: 'called', currentPoint: 7, sequenceNo: 3, issuedAt: '2026-10-25T03:00:00.000Z', calledAt: '2026-10-25T03:10:00.000Z' },
      ],
      servicePoints: [{ point: 1, name: 'เวชระเบียนและวัดค่าพื้นฐาน' }, { point: 4, name: 'พบแพทย์' }, { point: 7, name: 'ทำแผล' }],
    },
    setQueue: vi.fn(), loading: false, refreshing: false, error: '', refresh: vi.fn(),
  }),
}));

vi.mock('../src/hooks/useDashboardMetrics.js', () => ({
  useDashboardMetrics: () => ({
    metrics: { total: 3, waiting: 1, calling: 2, completed: 0, averageWaitMinutes: 10, averageServiceMinutes: 15, stations: [], hourly: [] },
    loading: false, error: '', refresh: vi.fn(),
  }),
}));

vi.mock('../src/api.js', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, apiConfig: { url: '', configured: false }, apiRequest: vi.fn(async () => ({ tickets: [] })) };
});

import App from '../src/App.jsx';

function openRoute(route, authenticated = false, point = 4) {
  sessionStorage.clear();
  if (authenticated) {
    sessionStorage.setItem('queueflow-authenticated', 'true');
    sessionStorage.setItem('queueflow-service-point', String(point));
    sessionStorage.setItem('queueflow-staff-name', 'เจ้าหน้าที่ทดสอบ');
  }
  window.history.replaceState(null, '', `/#${route}`);
  return render(<App />);
}

describe('application routes', () => {
  beforeEach(() => {
    localStorage.clear();
    window.alert = vi.fn();
    reportMocks.downloadCsvReport.mockReset();
    reportMocks.downloadExcelReport.mockReset().mockResolvedValue(undefined);
    reportMocks.printReport.mockReset();
  });
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  it('shows the Thai home menu', () => {
    const { container } = openRoute('/');
    expect(container.textContent).toContain('เลือกเมนูการใช้งาน');
    expect(container.textContent).toContain('กดบัตรคิว');
    expect(container.textContent).toContain('หน้าแสดงคิว');
  });

  it('issues a general queue ticket from the kiosk', async () => {
    const { container } = openRoute('/kiosk');
    fireEvent.click(screen.getByText('ผู้ป่วยทั่วไป'));
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันรับบัตรคิว' }));
    await waitFor(() => expect(container.textContent).toContain('ออกบัตรคิวสำเร็จ'));
  });

  it('validates login and signs a service-point user in', async () => {
    const { container } = openRoute('/login');
    fireEvent.change(screen.getByLabelText('ชื่อผู้ใช้'), { target: { value: 'wrong' } });
    fireEvent.change(screen.getByLabelText('รหัสผ่าน'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ระบบ' }));
    expect(container.textContent).toContain('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    fireEvent.change(screen.getByLabelText('ชื่อผู้ใช้'), { target: { value: 'point4' } });
    fireEvent.change(screen.getByLabelText('รหัสผ่าน'), { target: { value: 'test1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ระบบ' }));
    await waitFor(() => expect(sessionStorage.getItem('queueflow-authenticated')).toBe('true'));
  });

  it('opens the KU All-Login mock without creating a session', async () => {
    openRoute('/login');
    fireEvent.click(screen.getByRole('button', { name: /เข้าสู่ระบบด้วย KU All-Login/ }));
    expect(window.location.hash).toBe('#/auth/ku-alllogin');
    expect(await screen.findByText('ยังไม่ได้เชื่อมต่อระบบจริง')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'กลับไปเข้าสู่ระบบแบบเดิม' })).toBeTruthy();
    expect(sessionStorage.getItem('queueflow-authenticated')).toBeNull();
  });

  it('protects staff routes and renders an authenticated queue station', () => {
    const loggedOut = openRoute('/operator');
    expect(loggedOut.container.textContent).toContain('เข้าสู่ระบบเจ้าหน้าที่');
    cleanup();
    const loggedIn = openRoute('/operator', true);
    expect(loggedIn.container.textContent).toContain('จุดบริการ 4');
    expect(loggedIn.container.textContent).toContain('เสียงประกาศ');
  });

  it('renders display and dashboard routes', () => {
    const display = openRoute('/display');
    expect(display.container.textContent).toContain('Q002');
    expect(display.container.textContent).toContain('จุดบริการ 4');
    cleanup();
    const dashboard = openRoute('/dashboard', true);
    expect(dashboard.container.textContent).toContain('ภาพรวมการให้บริการ');
    expect(dashboard.container.textContent).toContain('พิมพ์เอกสาร');
  });

  it('redirects the removed report route to dashboard', () => {
    const { container } = openRoute('/report', true);
    expect(window.location.hash).toBe('#/dashboard');
    expect(container.textContent).toContain('ภาพรวมการให้บริการ');
  });

  it('prints and exports every dashboard report format', async () => {
    openRoute('/dashboard', true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'พิมพ์เอกสาร' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'พิมพ์เอกสาร' }));
    fireEvent.click(screen.getByRole('button', { name: 'ตารางคำนวณ' }));
    await waitFor(() => expect(reportMocks.downloadExcelReport).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'ข้อมูลแบบคั่นด้วยจุลภาค' }));
    expect(reportMocks.printReport).toHaveBeenCalledOnce();
    expect(reportMocks.downloadCsvReport).toHaveBeenCalledOnce();
  });

  it('validates a custom report date range', async () => {
    const { container } = openRoute('/dashboard', true);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('วันที่เริ่มต้น'), { target: { value: '2026-10-25' } });
    fireEvent.change(screen.getByLabelText('วันที่สิ้นสุด'), { target: { value: '2026-10-01' } });
    await waitFor(() => expect(container.textContent).toContain('ช่วงวันที่ไม่ถูกต้อง'));
  });

  it('shows an export error returned by the report generator', async () => {
    const { container } = openRoute('/dashboard', true);
    reportMocks.downloadExcelReport.mockRejectedValueOnce(new Error('สร้าง Excel ไม่สำเร็จ'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'ตารางคำนวณ' }).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'ตารางคำนวณ' }));
    await waitFor(() => expect(container.textContent).toContain('สร้าง Excel ไม่สำเร็จ'));
  });

  it('calls the oldest waiting queue at the signed-in service point', async () => {
    openRoute('/operator', true, 1);
    fireEvent.click(screen.getAllByRole('button', { name: 'เรียกคิว' })[1]);
    expect(await screen.findByText('เจ้าหน้าที่ทดสอบ')).toBeTruthy();
  });
});
