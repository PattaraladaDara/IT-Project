import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const server = require('../server/index.js');
const originalPoolQuery = server.__pool.query.bind(server.__pool);
const originalPoolConnect = server.__pool.connect.bind(server.__pool);

function responseMock() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead: vi.fn(function writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    }),
    end: vi.fn(function end(body = '') { this.body = body; }),
  };
}

function requestWithBody(body, method = 'POST') {
  const req = new EventEmitter();
  req.method = method;
  req.setEncoding = vi.fn();
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', body);
    req.emit('end');
  });
  return req;
}

describe('server validation and mapping', () => {
  it('normalizes accepted identifiers', () => {
    expect(server.cleanPrefix(' q1 ')).toBe('Q1');
    expect(server.cleanCounter(' 4 ')).toBe('4');
    expect(server.cleanQueue(' q001 ')).toBe('Q001');
    expect(server.cleanTicketId('42')).toBe(42);
    expect(server.cleanServicePoint('7')).toBe(7);
    expect(server.getAllowedServiceRoutes(7)).toEqual([4, 6, 'complete']);
  });

  it('rejects malformed identifiers', () => {
    expect(() => server.cleanPrefix('invalid prefix!')).toThrow();
    expect(() => server.cleanCounter('')).toThrow();
    expect(() => server.cleanQueue('!')).toThrow();
    expect(() => server.cleanTicketId('-1')).toThrow();
    expect(() => server.cleanServicePoint('2')).toThrow();
  });

  it('maps database rows to public ticket data', () => {
    const result = server.mapTicketRow({ id: 9, ticketCode: 'Q009', category: 'emergency', priority: '100', status: 'done', sequenceNo: '9', issuedAt: 'start', currentPoint: '7' });
    expect(result).toMatchObject({ id: '9', queue: 'Q009', categoryLabel: 'ผู้ป่วยฉุกเฉิน', priority: 100, status: 'completed', sequenceNo: 9, currentPoint: 7, arrivedAt: 'start' });
    expect(server.categoryLabel('general')).toBe('ผู้ป่วยทั่วไป');
  });
});

describe('server HTTP helpers', () => {
  it('sends JSON success and error responses', () => {
    const ok = responseMock();
    server.sendJson(ok, 201, { ok: true });
    expect(ok.statusCode).toBe(201);
    expect(JSON.parse(ok.body)).toEqual({ ok: true });
    const failed = responseMock();
    server.sendError(failed, 400, 'ไม่ถูกต้อง');
    expect(JSON.parse(failed.body)).toEqual({ error: 'ไม่ถูกต้อง' });
  });

  it('parses empty, valid and invalid request bodies', async () => {
    await expect(server.readBody(requestWithBody())).resolves.toEqual({});
    await expect(server.readBody(requestWithBody('{"action":"getQueue"}'))).resolves.toEqual({ action: 'getQueue' });
    await expect(server.readBody(requestWithBody('{bad'))).rejects.toThrow('request body is not valid JSON');
  });

  it('handles preflight, unsupported methods and unknown GET actions', async () => {
    const preflight = responseMock();
    await server.handleApi({ method: 'OPTIONS' }, preflight, new URL('http://localhost/api'));
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers.Allow).toContain('POST');
    expect(preflight.headers['Access-Control-Allow-Origin']).toBeUndefined();
    const method = responseMock();
    await server.handleApi({ method: 'PATCH' }, method, new URL('http://localhost/api'));
    expect(method.statusCode).toBe(405);
    const unknown = responseMock();
    await server.handleApi({ method: 'GET' }, unknown, new URL('http://localhost/api?action=unknown'));
    expect(unknown.statusCode).toBe(400);
  });

  it('rejects every mutating GET action before database access', async () => {
    const originalQuery = server.__pool.query;
    server.__pool.query = vi.fn();
    try {
      for (const action of ['take', 'next', 'recall', 'done', 'skip', 'requeue', 'resetDay']) {
        const res = responseMock();
        await server.handleApi({ method: 'GET' }, res, new URL(`http://localhost/api?action=${action}&confirm=yes`));
        expect(res.statusCode).toBe(405);
        expect(JSON.parse(res.body).error).toContain('POST');
      }
      expect(server.__pool.query).not.toHaveBeenCalled();
    } finally {
      server.__pool.query = originalQuery;
    }
  });

  it('handles POST requests with missing and unknown actions', async () => {
    const missing = responseMock();
    await server.handlePostApi(requestWithBody('{}'), missing);
    expect(missing.statusCode).toBe(400);
    const unknown = responseMock();
    await server.handlePostApi(requestWithBody('{"action":"unknown","payload":{}}'), unknown);
    expect(unknown.statusCode).toBe(500);
  });

  it('serves the built application and rejects missing assets', async () => {
    const page = responseMock();
    server.serveStatic(page, '/');
    await vi.waitFor(() => expect(page.end).toHaveBeenCalled());
    expect(page.statusCode).toBe(200);
    const missing = responseMock();
    server.serveStatic(missing, '/assets/not-found.js');
    await vi.waitFor(() => expect(missing.end).toHaveBeenCalled());
    expect(missing.statusCode).toBe(404);
  });

  it('rejects an unsupported React action before database access', async () => {
    await expect(server.runReactAction('unknown', {})).rejects.toThrow('ไม่รู้จักคำสั่ง');
  });

  it('recalls a skipped service step when no real active ticket remains', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 77, queue: 'Q001' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    server.__pool.connect = vi.fn().mockResolvedValue(client);
    try {
      await expect(server.recallServiceStep(1, 4)).resolves.toEqual({ ok: true, queue: 'Q001', servicePoint: 4 });
      expect(client.query.mock.calls[2][0]).toContain('active_ticket.queue_date = CURRENT_DATE');
      expect(client.query.mock.calls[2][0]).toContain("active_ticket.status = 'called'");
      expect(client.query.mock.calls[4][0]).toContain('skipped_at = NULL');
      expect(client.release).toHaveBeenCalledOnce();
    } finally {
      server.__pool.connect = originalPoolConnect;
    }
  });

  it('keeps a skipped queue unchanged while the same service point is busy', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 78, queue: 'Q002' }] })
        .mockResolvedValueOnce({ rows: [{ exists: 1 }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    server.__pool.connect = vi.fn().mockResolvedValue(client);
    try {
      await expect(server.recallServiceStep(2, 1)).resolves.toEqual({ error: 'กรุณาดำเนินการกับคิวปัจจุบันที่จุดบริการ 1 ให้เสร็จก่อน' });
      expect(client.query).toHaveBeenCalledTimes(4);
      expect(client.query.mock.calls[3][0]).toBe('COMMIT');
      expect(client.release).toHaveBeenCalledOnce();
    } finally {
      server.__pool.connect = originalPoolConnect;
    }
  });
});

describe('server reporting queries', () => {
  beforeEach(() => { server.__pool.query = vi.fn(); });
  afterEach(() => { server.__pool.query = originalPoolQuery; });

  it('builds queue data with history and service points', async () => {
    server.__pool.query
      .mockResolvedValueOnce({ rows: [{ id: 1, ticketCode: 'Q001', category: 'general', status: 'waiting', sequenceNo: 1, issuedAt: '2026-10-25T01:00:00Z' }] })
      .mockResolvedValueOnce({ rows: [{ stepId: 8, ticketId: 1, ticketCode: 'Q001', category: 'general', currentPoint: 4, completedAt: '2026-10-25T02:00:00Z' }] })
      .mockResolvedValueOnce({ rows: [{ point: 1, name: 'เวชระเบียน' }] });
    const data = await server.getQueueData();
    expect(data.waiting).toHaveLength(1);
    expect(data.history[0]).toMatchObject({ id: 'history-8', ticketCode: 'Q001', currentPoint: 4 });
    expect(data.servicePoints[0].point).toBe(1);
  });

  it('normalizes dashboard summary, hourly and station metrics', async () => {
    server.__pool.query
      .mockResolvedValueOnce({ rows: [{ total: '5', waiting: '2', calling: '1', completed: '2', skipped: '0', cancelled: '0', general: '4', emergency: '1', averageWaitMinutes: '7', averageServiceMinutes: '12' }] })
      .mockResolvedValueOnce({ rows: [{ hour: '8', users: '3', averageWaitMinutes: '5', averageServiceMinutes: '10' }] })
      .mockResolvedValueOnce({ rows: [{ station: '4', served: '3', averageWaitMinutes: '5', averageServiceMinutes: '10' }] });
    const data = await server.getDashboard();
    expect(data).toMatchObject({ total: 5, waiting: 2, calling: 1, emergency: 1 });
    expect(data.hourly[0]).toEqual({ hour: 8, users: 3, averageWaitMinutes: 5, averageServiceMinutes: 10 });
    expect(data.stations[0].served).toBe(3);
    expect(data.generatedAt).toBeTruthy();
  });

  it('validates and returns report ranges', async () => {
    await expect(server.getReport({ period: 'custom', start: 'bad', end: '2026-10-25' })).resolves.toEqual(expect.objectContaining({ error: expect.any(String) }));
    server.__pool.query
      .mockResolvedValueOnce({ rows: [{ startDate: '2026-10-01', endDate: '2026-10-25' }] })
      .mockResolvedValueOnce({ rows: [{ id: 1, ticketCode: 'Q001', category: 'general', status: 'done', sequenceNo: 1 }] });
    const data = await server.getReport({ period: 'custom', start: '2026-10-01', end: '2026-10-25' });
    expect(data.period).toBe('custom');
    expect(data.tickets[0].status).toBe('completed');
  });

  it('returns legacy status, queue list and health data', async () => {
    server.__pool.query
      .mockResolvedValueOnce({ rows: [{ count: 2 }] })
      .mockResolvedValueOnce({ rows: [{ queue: 'Q001' }] })
      .mockResolvedValueOnce({ rows: [{ queue: 'Q000' }] });
    await expect(server.getStatus()).resolves.toEqual({ ok: true, waitingCount: 2, calling: [{ queue: 'Q001' }], history: [{ queue: 'Q000' }] });

    server.__pool.query.mockResolvedValueOnce({ rows: [{ queue: 'Q001', status: 'waiting' }] });
    await expect(server.getQueueList()).resolves.toEqual({ ok: true, list: [{ queue: 'Q001', status: 'waiting' }] });

    server.__pool.query.mockResolvedValueOnce({ rows: [{ database: 'queueflow_dev', now: 'now' }] });
    await expect(server.getHealth()).resolves.toEqual({ ok: true, database: 'queueflow_dev', now: 'now' });
  });
});
