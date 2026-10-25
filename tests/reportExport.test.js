import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import {
  buildPdfFromJpegPages,
  createExcelReportBlob,
  createPdfReportBlob,
  downloadCsvReport,
  downloadExcelReport,
  downloadPdfReport,
  printReport,
} from '../src/reportExport.js';

const sampleTickets = [
  { ticketCode: 'Q001', category: 'general', status: 'completed', currentPoint: 6, issuedAt: '2026-10-25T01:00:00.000Z', completedAt: '2026-10-25T01:30:00.000Z' },
  { queue: 'Q002', category: 'emergency', status: 'called', currentPoint: 7, issuedAt: '2026-10-25T02:00:00.000Z' },
  { ticketCode: 'Q003', category: 'unknown', status: 'custom', issuedAt: 'invalid' },
];

const options = {
  tickets: sampleTickets,
  periodLabel: 'วันนี้/ทดสอบ',
  startDate: '2026-10-25T00:00:00.000Z',
  endDate: '2026-10-25T23:59:59.000Z',
};

function readBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result), { once: true });
    reader.addEventListener('error', () => reject(reader.error), { once: true });
    reader.readAsArrayBuffer(blob);
  });
}

function installCanvasMock() {
  const context = {
    fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  HTMLCanvasElement.prototype.toBlob = function toBlob(callback) {
    callback({ arrayBuffer: async () => new Uint8Array([255, 216, 255, 217]).buffer });
  };
  return context;
}

describe('report exports', () => {
  beforeEach(() => {
    global.FontFace = class FontFace { load() { return Promise.resolve(this); } };
    Object.defineProperty(document, 'fonts', { configurable: true, value: { add: vi.fn(), ready: Promise.resolve() } });
    URL.createObjectURL = vi.fn(() => 'blob:queueflow');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('creates a readable Excel workbook with summary and queue rows', async () => {
    const blob = await createExcelReportBlob(options);
    expect(blob.type).toContain('spreadsheetml');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await readBlob(blob));
    const sheet = workbook.getWorksheet('รายงานคิว');
    expect(sheet.getCell('A1').value).toContain('รายงานสรุป');
    expect(sheet.getCell('B8').value).toBe(3);
    expect(sheet.getCell('B12').value).toBe('Q001');
    expect(sheet.getCell('C13').value).toBe('อุบัติเหตุ');
  });

  it('creates an empty Excel report when no queues exist', async () => {
    const blob = await createExcelReportBlob({ ...options, tickets: [] });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await readBlob(blob));
    expect(workbook.getWorksheet('รายงานคิว').getCell('A12').value).toContain('ไม่มีข้อมูล');
  });

  it('builds single and multi-page PDF blobs', async () => {
    const single = buildPdfFromJpegPages([new Uint8Array([1, 2, 3])]);
    const multi = buildPdfFromJpegPages([new Uint8Array([1]), new Uint8Array([2])]);
    expect(single.type).toBe('application/pdf');
    expect(new TextDecoder().decode(await readBlob(multi))).toContain('/Count 2');
  });

  it('renders report pages to a PDF with canvas and formal fonts', async () => {
    const context = installCanvasMock();
    const manyTickets = Array.from({ length: 20 }, (_, index) => ({ ...sampleTickets[0], ticketCode: `Q${String(index + 1).padStart(3, '0')}` }));
    const blob = await createPdfReportBlob({ ...options, tickets: manyTickets });
    expect(blob.type).toBe('application/pdf');
    expect(context.fillText).toHaveBeenCalledWith('รายงานสรุปการให้บริการ', 620, 68);
  });

  it('downloads CSV, Excel and PDF using safe filenames', async () => {
    installCanvasMock();
    downloadCsvReport(options);
    await downloadExcelReport(options);
    await downloadPdfReport(options);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(3);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledTimes(3);
  });

  it('prepares a dedicated printable iframe', async () => {
    vi.useFakeTimers();
    printReport(options);
    const frame = document.getElementById('queueflow-print-frame');
    expect(frame).not.toBeNull();
    expect(frame.srcdoc).toContain('รายงานสรุปการให้บริการ');
    frame.contentWindow.focus = vi.fn();
    frame.contentWindow.print = vi.fn();
    frame.dispatchEvent(new Event('load'));
    await Promise.resolve();
    expect(frame.contentWindow.print).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
