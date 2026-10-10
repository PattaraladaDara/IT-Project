'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || undefined,
  database: process.env.PGDATABASE || 'queueflow_dev',
  max: 10,
  idleTimeoutMillis: 30_000,
  options: '-c timezone=Asia/Bangkok'
});

pool.on('error', (error) => {
  console.error('[postgres] idle client error:', error.message);
});

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function cleanPrefix(value) {
  const prefix = String(value || 'A').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(prefix)) {
    throw new Error('prefix must contain 1-10 letters or numbers');
  }
  return prefix;
}

function cleanCounter(value) {
  const counter = String(value || '').trim();
  if (!counter || counter.length > 50) {
    throw new Error('กรุณาระบุหมายเลขช่องบริการ');
  }
  return counter;
}

function cleanQueue(value) {
  const queue = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,14}$/.test(queue)) {
    throw new Error('หมายเลขคิวไม่ถูกต้อง');
  }
  return queue;
}

function cleanTicketId(value) {
  const id = Number.parseInt(String(value || ''), 10);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('ticketId is invalid');
  }
  return id;
}

async function inTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
  }
}

async function addEvent(client, ticketId, action, counter = null, metadata = {}) {
  await client.query(
    `INSERT INTO queue_events (ticket_id, action, counter, metadata)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [ticketId, action, counter, JSON.stringify(metadata)]
  );
}

async function takeTicket(prefix, category = 'general', phone = null) {
  return inTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`queue:${prefix}`]);

    const sequenceResult = await client.query(
      `INSERT INTO queue_sequences (queue_date, prefix, last_number)
       VALUES (CURRENT_DATE, $1, 1)
       ON CONFLICT (queue_date, prefix)
       DO UPDATE SET last_number = queue_sequences.last_number + 1,
                     updated_at = now()
       RETURNING last_number`,
      [prefix]
    );
    const sequenceNo = sequenceResult.rows[0].last_number;

    const ticketResult = await client.query(
      `INSERT INTO queue_tickets (queue_date, prefix, sequence_no, category, phone, priority)
       VALUES (CURRENT_DATE, $1, $2, $3, $4, $5)
       RETURNING id, queue_code AS queue, created_at AS "createdAt"`,
      [prefix, sequenceNo, category, phone, category === 'emergency' ? 9 : 1]
    );
    const ticket = ticketResult.rows[0];
    await addEvent(client, ticket.id, 'issued', null, { prefix });

    const waitingResult = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM queue_tickets
       WHERE queue_date = CURRENT_DATE AND status = 'waiting'`
    );

    return {
      ok: true,
      queue: ticket.queue,
      createdAt: ticket.createdAt,
      waitingAhead: Math.max(0, waitingResult.rows[0].count - 1)
    };
  });
}

async function callNext(counter) {
  return inTransaction(async (client) => {
    const current = await client.query(
      `SELECT id, queue_code AS queue
       FROM queue_tickets
       WHERE queue_date = CURRENT_DATE AND status = 'called' AND counter = $1
       ORDER BY called_at DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [counter]
    );
    if (current.rows.length) {
      return {
        error: `กรุณากดเสร็จสิ้นหรือข้ามคิว ${current.rows[0].queue} ก่อนเรียกคิวถัดไป`,
        code: 'ACTIVE_TICKET'
      };
    }

    const next = await client.query(
      `SELECT id, queue_code AS queue
       FROM queue_tickets
       WHERE queue_date = CURRENT_DATE AND status = 'waiting'
       ORDER BY priority DESC,
                CASE WHEN requeue_count > 0 THEN updated_at ELSE created_at END,
                id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      []
    );
    if (!next.rows.length) {
      return { error: 'ไม่มีคิวรอเรียกในขณะนี้', code: 'NO_WAITING_TICKETS' };
    }

    const ticket = await client.query(
      `UPDATE queue_tickets
       SET status = 'called', counter = $1, called_at = now(),
           call_count = call_count + 1, updated_at = now()
       WHERE id = $2
       RETURNING id, queue_code AS queue, called_at AS "calledAt"`,
      [counter, next.rows[0].id]
    );
    const result = ticket.rows[0];
    await addEvent(client, result.id, 'called', counter);
    return { ok: true, queue: result.queue, calledAt: result.calledAt, counter };
  });
}

async function recallCurrent(counter) {
  return inTransaction(async (client) => {
    const result = await client.query(
      `UPDATE queue_tickets
       SET last_recalled_at = now(), call_count = call_count + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM queue_tickets
         WHERE queue_date = CURRENT_DATE AND status = 'called' AND counter = $1
         ORDER BY called_at DESC, id DESC LIMIT 1 FOR UPDATE
       )
       RETURNING id, queue_code AS queue, counter`,
      [counter]
    );
    if (!result.rows.length) return { error: 'ยังไม่มีคิวที่กำลังให้บริการในช่องนี้' };
    const ticket = result.rows[0];
    await addEvent(client, ticket.id, 'recalled', counter);
    return { ok: true, queue: ticket.queue, counter: ticket.counter };
  });
}

async function finishCurrent(counter, action) {
  return inTransaction(async (client) => {
    const status = action === 'done' ? 'done' : 'skipped';
    const timestampColumn = action === 'done' ? 'completed_at' : 'skipped_at';
    const result = await client.query(
      `UPDATE queue_tickets
       SET status = $1::queue_status, ${timestampColumn} = now(), updated_at = now()
       WHERE id = (
         SELECT id FROM queue_tickets
         WHERE queue_date = CURRENT_DATE AND status = 'called' AND counter = $2
         ORDER BY called_at DESC, id DESC LIMIT 1 FOR UPDATE
       )
       RETURNING id, queue_code AS queue, counter`,
      [status, counter]
    );
    if (!result.rows.length) return { error: 'ยังไม่มีคิวที่กำลังให้บริการในช่องนี้' };
    const ticket = result.rows[0];
    await addEvent(client, ticket.id, action, counter);
    return { ok: true, queue: ticket.queue, counter: ticket.counter };
  });
}

async function requeueTicket(queue) {
  return inTransaction(async (client) => {
    const result = await client.query(
      `UPDATE queue_tickets
       SET status = 'waiting', counter = NULL, called_at = NULL, skipped_at = NULL,
           requeue_count = requeue_count + 1, updated_at = now()
       WHERE id = (
         SELECT id
         FROM queue_tickets
         WHERE queue_date = CURRENT_DATE AND queue_code = $1 AND status = 'skipped'
         ORDER BY id DESC
         LIMIT 1
       )
       RETURNING id, queue_code AS queue`,
      [queue]
    );
    if (!result.rows.length) return { error: 'ไม่พบคิวที่ข้ามไว้สำหรับเรียกกลับเข้าคิว' };
    const ticket = result.rows[0];
    await addEvent(client, ticket.id, 'requeued', null, { queue });
    return { ok: true, queue: ticket.queue };
  });
}

async function callTicketById(ticketId, counter) {
  return inTransaction(async (client) => {
    const current = await client.query(
      `SELECT id, queue_code AS queue
       FROM queue_tickets
       WHERE queue_date = CURRENT_DATE AND status = 'called' AND counter = $1
       LIMIT 1 FOR UPDATE`,
      [counter]
    );
    if (current.rows.length && current.rows[0].id !== ticketId) {
      return { error: `กรุณาดำเนินการกับคิว ${current.rows[0].queue} ให้เสร็จก่อน` };
    }
    const result = await client.query(
      `UPDATE queue_tickets
       SET status = 'called', counter = $1, called_at = COALESCE(called_at, now()),
           call_count = call_count + 1, updated_at = now()
       WHERE id = $2 AND queue_date = CURRENT_DATE AND status IN ('waiting', 'skipped')
       RETURNING id, queue_code AS queue, called_at AS "calledAt"`,
      [counter, ticketId]
    );
    if (!result.rows.length) return { error: 'ไม่พบคิวที่สามารถเรียกได้' };
    const ticket = result.rows[0];
    await addEvent(client, ticket.id, 'called', counter);
    return { ok: true, queue: ticket.queue, calledAt: ticket.calledAt, counter };
  });
}

async function recallTicketById(ticketId, counter) {
  return inTransaction(async (client) => {
    const result = await client.query(
      `UPDATE queue_tickets
       SET status = 'called', counter = COALESCE(counter, $1),
           called_at = COALESCE(called_at, now()), last_recalled_at = now(),
           call_count = call_count + 1, updated_at = now()
       WHERE id = $2 AND queue_date = CURRENT_DATE AND status IN ('called', 'skipped')
       RETURNING id, queue_code AS queue, counter`,
      [counter, ticketId]
    );
    if (!result.rows.length) return { error: 'ไม่พบคิวที่สามารถเรียกซ้ำได้' };
    const ticket = result.rows[0];
    await addEvent(client, ticket.id, 'recalled', ticket.counter);
    return { ok: true, queue: ticket.queue, counter: ticket.counter };
  });
}

async function finishTicketById(ticketId, action) {
  return inTransaction(async (client) => {
    const status = action === 'completeTicket' ? 'done' : 'skipped';
    const timestampColumn = status === 'done' ? 'completed_at' : 'skipped_at';
    const eventAction = status === 'done' ? 'done' : 'skipped';
    const result = await client.query(
      `UPDATE queue_tickets
       SET status = $1::queue_status, ${timestampColumn} = now(), updated_at = now()
       WHERE id = $2 AND queue_date = CURRENT_DATE AND status = 'called'
       RETURNING id, queue_code AS queue, counter`,
      [status, ticketId]
    );
    if (!result.rows.length) return { error: 'ไม่พบคิวที่กำลังให้บริการ' };
    const ticket = result.rows[0];
    await addEvent(client, ticket.id, eventAction, ticket.counter);
    return { ok: true, queue: ticket.queue, counter: ticket.counter };
  });
}

async function cancelTicket(ticketId) {
  return inTransaction(async (client) => {
    const result = await client.query(
      `UPDATE queue_tickets
       SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND queue_date = CURRENT_DATE AND status = 'waiting'
       RETURNING id, queue_code AS queue`,
      [ticketId]
    );
    if (!result.rows.length) return { error: 'ลบคิวนี้ไม่ได้ เพราะคิวถูกเรียกหรือจบงานแล้ว' };
    const ticket = result.rows[0];
    await addEvent(client, ticket.id, 'cancelled');
    return { ok: true, queue: ticket.queue };
  });
}

function categoryLabel(category) {
  return category === 'emergency' ? 'ผู้ป่วยฉุกเฉิน' : 'ผู้ป่วยทั่วไป';
}

function mapTicketRow(row) {
  return {
    id: String(row.id),
    ticketCode: row.ticketCode,
    queue: row.ticketCode,
    category: row.category || 'general',
    categoryLabel: categoryLabel(row.category),
    priority: Number(row.priority || 0),
    status: row.status === 'done' ? 'completed' : row.status,
    sequenceNo: Number(row.sequenceNo),
    issuedAt: row.issuedAt,
    calledAt: row.calledAt,
    completedAt: row.completedAt,
    skippedAt: row.skippedAt,
    phone: row.phone || null,
    counter: row.counter || null
  };
}

async function getQueueData() {
  const result = await pool.query(
    `SELECT id, queue_code AS "ticketCode", category, priority,
            status, sequence_no AS "sequenceNo", created_at AS "issuedAt",
            called_at AS "calledAt", completed_at AS "completedAt",
            skipped_at AS "skippedAt", phone, counter
     FROM queue_tickets
     WHERE queue_date = CURRENT_DATE
     ORDER BY created_at ASC, id ASC`
  );
  const tickets = result.rows.map(mapTicketRow);
  const current = tickets.find(ticket => ticket.status === 'called') || null;
  return {
    date: new Date().toISOString().slice(0, 10),
    tickets,
    current,
    waiting: tickets.filter(ticket => ticket.status === 'waiting'),
    skipped: tickets.filter(ticket => ticket.status === 'skipped')
  };
}

async function getDashboard() {
  const [summaryResult, hourlyResult, stationResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting,
              COUNT(*) FILTER (WHERE status = 'called')::int AS calling,
              COUNT(*) FILTER (WHERE status = 'done')::int AS completed,
              COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
              COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
              COUNT(*) FILTER (WHERE category = 'general')::int AS general,
              COUNT(*) FILTER (WHERE category = 'emergency')::int AS emergency,
              COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (called_at - created_at)) / 60)
                FILTER (WHERE called_at IS NOT NULL)), 0)::int AS "averageWaitMinutes",
              COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - called_at)) / 60)
                FILTER (WHERE completed_at IS NOT NULL)), 0)::int AS "averageServiceMinutes"
       FROM queue_tickets
       WHERE queue_date = CURRENT_DATE`
    ),
    pool.query(
      `WITH hours AS (
         SELECT generate_series(8, 19) AS hour
       )
       SELECT hours.hour::int AS hour,
              COUNT(t.id)::int AS users,
              COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (t.called_at - t.created_at)) / 60)
                FILTER (WHERE t.called_at IS NOT NULL)), 0)::int AS "averageWaitMinutes",
              COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (t.completed_at - t.called_at)) / 60)
                FILTER (WHERE t.completed_at IS NOT NULL)), 0)::int AS "averageServiceMinutes"
       FROM hours
       LEFT JOIN queue_tickets t
         ON t.queue_date = CURRENT_DATE
        AND EXTRACT(HOUR FROM t.created_at AT TIME ZONE 'Asia/Bangkok') = hours.hour
       GROUP BY hours.hour
       ORDER BY hours.hour`
    ),
    pool.query(
      `SELECT COALESCE(counter, 'ไม่ระบุ') AS station,
              COUNT(*) FILTER (WHERE called_at IS NOT NULL)::int AS served,
              COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (called_at - created_at)) / 60)
                FILTER (WHERE called_at IS NOT NULL)), 0)::int AS "averageWaitMinutes",
              COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (completed_at - called_at)) / 60)
                FILTER (WHERE completed_at IS NOT NULL)), 0)::int AS "averageServiceMinutes"
       FROM queue_tickets
       WHERE queue_date = CURRENT_DATE
       GROUP BY counter
       ORDER BY served DESC, station`
    )
  ]);

  const summary = summaryResult.rows[0] || {};
  const hourly = hourlyResult.rows.map(row => ({
    hour: Number(row.hour),
    users: Number(row.users || 0),
    averageWaitMinutes: Number(row.averageWaitMinutes || 0),
    averageServiceMinutes: Number(row.averageServiceMinutes || 0)
  }));
  const stations = stationResult.rows.map(row => ({
    station: row.station,
    served: Number(row.served || 0),
    averageWaitMinutes: Number(row.averageWaitMinutes || 0),
    averageServiceMinutes: Number(row.averageServiceMinutes || 0)
  }));

  return {
    ...summary,
    total: Number(summary.total || 0),
    waiting: Number(summary.waiting || 0),
    calling: Number(summary.calling || 0),
    completed: Number(summary.completed || 0),
    skipped: Number(summary.skipped || 0),
    cancelled: Number(summary.cancelled || 0),
    general: Number(summary.general || 0),
    emergency: Number(summary.emergency || 0),
    averageWaitMinutes: Number(summary.averageWaitMinutes || 0),
    averageServiceMinutes: Number(summary.averageServiceMinutes || 0),
    hourly,
    stations,
    generatedAt: new Date().toISOString()
  };
}

async function getStatus() {
  const [waiting, calling, history] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS count FROM queue_tickets
       WHERE queue_date = CURRENT_DATE AND status = 'waiting'`
    ),
    pool.query(
      `SELECT queue_code AS queue, counter, called_at AS "calledAt"
       FROM queue_tickets
       WHERE queue_date = CURRENT_DATE AND status = 'called'
       ORDER BY called_at DESC, id DESC`
    ),
    pool.query(
      `SELECT queue_code AS queue, counter, called_at AS "calledAt"
       FROM queue_tickets
       WHERE queue_date = CURRENT_DATE AND called_at IS NOT NULL
       ORDER BY called_at DESC, id DESC LIMIT 30`
    )
  ]);
  return {
    ok: true,
    waitingCount: waiting.rows[0].count,
    calling: calling.rows,
    history: history.rows
  };
}

async function getQueueList() {
  const result = await pool.query(
    `SELECT queue_code AS queue, status, counter,
            created_at AS "createdAt", called_at AS "calledAt",
            completed_at AS "completedAt", skipped_at AS "skippedAt",
            priority, requeue_count AS "requeueCount"
     FROM queue_tickets
     WHERE queue_date = CURRENT_DATE
     ORDER BY created_at ASC, id ASC`
  );
  return { ok: true, list: result.rows };
}

async function resetToday() {
  return inTransaction(async (client) => {
    await client.query(
      `DELETE FROM queue_events e
       USING queue_tickets t
       WHERE e.ticket_id = t.id AND t.queue_date = CURRENT_DATE`
    );
    const deleted = await client.query(
      `DELETE FROM queue_tickets WHERE queue_date = CURRENT_DATE`
    );
    await client.query(`DELETE FROM queue_sequences WHERE queue_date = CURRENT_DATE`);
    return { ok: true, deleted: deleted.rowCount };
  });
}

async function getHealth() {
  const result = await pool.query('SELECT current_database() AS database, now() AS now');
  return { ok: true, database: result.rows[0].database, now: result.rows[0].now };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (_) { reject(new Error('request body is not valid JSON')); }
    });
    req.on('error', reject);
  });
}

async function runReactAction(action, payload) {
  const counter = cleanCounter(payload.counter || payload.operatorId || '2');
  let result;
  switch (action) {
    case 'getQueue':
      return getQueueData();
    case 'getDashboard':
      return getDashboard();
    case 'createTicket': {
      const category = payload.category === 'emergency' ? 'emergency' : 'general';
      const phone = payload.phone ? String(payload.phone).trim().slice(0, 30) : null;
      result = await takeTicket('Q', category, phone);
      break;
    }
    case 'callNext':
      result = await callNext(counter);
      break;
    case 'callTicket':
      result = await callTicketById(cleanTicketId(payload.ticketId), counter);
      break;
    case 'skipTicket':
      result = await finishTicketById(cleanTicketId(payload.ticketId), 'skipTicket');
      break;
    case 'recallTicket':
      result = await recallTicketById(cleanTicketId(payload.ticketId), counter);
      break;
    case 'repeatCall':
      result = await recallTicketById(cleanTicketId(payload.ticketId), counter);
      break;
    case 'completeTicket':
      result = await finishTicketById(cleanTicketId(payload.ticketId), 'completeTicket');
      break;
    case 'cancelTicket':
      result = await cancelTicket(cleanTicketId(payload.ticketId));
      break;
    default:
      throw new Error(`ไม่รู้จัก action: ${action}`);
  }
  if (result.error) return result;
  const queue = await getQueueData();
  const ticket = result.queue
    ? queue.tickets.find(item => item.ticketCode === result.queue) || null
    : null;
  return { queue, ticket };
}

async function handlePostApi(req, res) {
  try {
    const body = await readBody(req);
    const action = String(body.action || '').trim();
    if (!action) return sendJson(res, 400, { ok: false, error: 'ต้องระบุ action' });
    const data = await runReactAction(action, body.payload || {});
    if (data?.error) return sendJson(res, 409, { ok: false, error: data.error });
    return sendJson(res, 200, { ok: true, data });
  } catch (error) {
    console.error('[api:POST]', error);
    return sendJson(res, 500, { ok: false, error: 'เชื่อมต่อฐานข้อมูลหรือประมวลผลคำขอไม่สำเร็จ' });
  }
}

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }
  if (req.method !== 'GET') return sendError(res, 405, 'Only GET or POST is supported for this local API');

  const action = (url.searchParams.get('action') || 'health').trim();
  try {
    let result;
    switch (action) {
      case 'health':
        result = await getHealth();
        break;
      case 'take':
        result = await takeTicket(cleanPrefix(url.searchParams.get('prefix')));
        break;
      case 'next':
        result = await callNext(cleanCounter(url.searchParams.get('counter')));
        break;
      case 'recall':
        result = await recallCurrent(cleanCounter(url.searchParams.get('counter')));
        break;
      case 'done':
        result = await finishCurrent(cleanCounter(url.searchParams.get('counter')), 'done');
        break;
      case 'skip':
        result = await finishCurrent(cleanCounter(url.searchParams.get('counter')), 'skip');
        break;
      case 'requeue':
        result = await requeueTicket(cleanQueue(url.searchParams.get('queue')));
        break;
      case 'status':
        result = await getStatus();
        break;
      case 'queueList':
        result = await getQueueList();
        break;
      case 'resetDay':
        if (url.searchParams.get('confirm') !== 'yes') {
          result = { error: 'ต้องยืนยันด้วย confirm=yes ก่อนรีเซ็ตคิววันนี้' };
        } else {
          result = await resetToday();
        }
        break;
      default:
        return sendError(res, 400, `ไม่รู้จัก action: ${action}`);
    }
    return sendJson(res, result.error ? 409 : 200, result);
  } catch (error) {
    console.error(`[api:${action}]`, error);
    return sendError(res, 500, 'เชื่อมต่อฐานข้อมูลหรือประมวลผลคำขอไม่สำเร็จ');
  }
}

function serveStatic(res, pathname) {
  const builtIndex = path.join(DIST, 'index.html');
  if (fs.existsSync(builtIndex)) {
    let filePath;
    if (pathname.startsWith('/assets/')) {
      const relativeAsset = pathname.slice(1).replaceAll('/', path.sep);
      filePath = path.resolve(DIST, relativeAsset);
      if (!filePath.startsWith(`${DIST}${path.sep}`)) return sendError(res, 400, 'invalid asset path');
    } else {
      // React Router uses hash routes, so every non-asset path serves the SPA shell.
      filePath = builtIndex;
    }
    return fs.readFile(filePath, (error, content) => {
      if (error) return sendError(res, 404, 'ไม่พบไฟล์หน้าเว็บ');
      const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(content);
    });
  }

  const fileMap = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/admin': 'admin.html',
    '/admin.html': 'admin.html',
    '/kiosk': 'kiosk.html',
    '/kiosk.html': 'kiosk.html'
  };
  const relativePath = fileMap[pathname];
  if (!relativePath) return sendError(res, 404, 'ไม่พบหน้าเว็บนี้');

  const filePath = path.join(ROOT, relativePath);
  fs.readFile(filePath, (error, content) => {
    if (error) return sendError(res, 404, 'ไม่พบไฟล์หน้าเว็บ');
    const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    if (req.method === 'POST') return handlePostApi(req, res);
    return handleApi(req, res, url);
  }
  return serveStatic(res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`QueueFlow local server: http://${HOST}:${PORT}`);
  console.log(`Database target: ${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'queueflow_dev'}`);
  console.log('Pages: / (home), /#/kiosk, /#/display, /#/login');
});

async function shutdown(signal) {
  console.log(`\nReceived ${signal}; shutting down...`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
