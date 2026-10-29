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
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function cleanPrefix(value) {
  const prefix = String(value || 'A').trim().toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(prefix)) {
    throw new Error('อักษรนำหน้าคิวต้องเป็นตัวอักษรหรือตัวเลขจำนวน 1–10 ตัว');
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
    throw new Error('รหัสบัตรคิวไม่ถูกต้อง');
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
    await client.query(
      `INSERT INTO ticket_service_steps (ticket_id, service_point, step_status, route_order)
       VALUES ($1, 1, 'waiting', 1)`,
      [ticket.id]
    );
    await client.query(`UPDATE queue_tickets SET current_service_point = 1 WHERE id = $1`, [ticket.id]);
    await addEvent(client, ticket.id, 'issued', null, { prefix });

    const waitingResult = await client.query(
      `SELECT COUNT(*)::int AS count
       FROM ticket_service_steps s
       JOIN queue_tickets t ON t.id = s.ticket_id
       WHERE t.queue_date = CURRENT_DATE AND s.service_point = 1 AND s.step_status = 'waiting'`
    );

    return {
      ok: true,
      queue: ticket.queue,
      createdAt: ticket.createdAt,
      waitingAhead: Math.max(0, waitingResult.rows[0].count - 1)
    };
  });
}

async function legacyCallNext(counter) {
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

const SERVICE_POINTS = {
  1: 'เวชระเบียนและวัดค่าพื้นฐาน',
  3: 'คัดกรอง',
  4: 'พบแพทย์',
  6: 'ส่งใบสั่งยาและรับยา',
  7: 'ทำแผล'
};

function cleanServicePoint(value) {
  const point = Number.parseInt(String(value || ''), 10);
  if (!SERVICE_POINTS[point]) throw new Error('จุดบริการไม่ถูกต้อง');
  return point;
}

async function addStep(client, ticketId, point, status = 'waiting', order = 1) {
  await client.query(
    `INSERT INTO ticket_service_steps (ticket_id, service_point, step_status, route_order)
     VALUES ($1, $2, $3, $4)`, [ticketId, point, status, order]
  );
}

async function callNext(counter, requestedPoint = null) {
  const point = requestedPoint || cleanServicePoint(counter);
  return inTransaction(async (client) => {
    const current = await client.query(
      `SELECT t.id, t.queue_code AS queue
       FROM queue_tickets t JOIN ticket_service_steps s ON s.ticket_id = t.id
       WHERE t.queue_date = CURRENT_DATE AND s.service_point = $1 AND s.step_status = 'called'
       LIMIT 1 FOR UPDATE`, [point]
    );
    if (current.rows.length) return { error: `กรุณาดำเนินการกับคิว ${current.rows[0].queue} ที่จุดบริการ ${point} ให้เสร็จก่อน` };
    const next = await client.query(
      `SELECT s.id AS step_id, t.id, t.queue_code AS queue
       FROM ticket_service_steps s
       JOIN queue_tickets t ON t.id = s.ticket_id
       WHERE t.queue_date = CURRENT_DATE AND t.status = 'waiting' AND s.service_point = $1 AND s.step_status = 'waiting'
       ORDER BY s.created_at ASC, s.id ASC
       LIMIT 1 FOR UPDATE SKIP LOCKED`, [point]
    );
    if (!next.rows.length) return { error: `ไม่มีคิวรอเรียกที่จุดบริการ ${point}` };
    await client.query(`UPDATE ticket_service_steps SET step_status = 'called', called_at = now(), updated_at = now() WHERE id = $1`, [next.rows[0].step_id]);
    await client.query(
      `UPDATE queue_tickets
       SET status = 'called', counter = $1, current_service_point = $2,
           called_at = now(), call_count = call_count + 1
       WHERE id = $3`,
      [String(point), point, next.rows[0].id]
    );
    await addEvent(client, next.rows[0].id, 'called', String(point), { servicePoint: point });
    return { ok: true, queue: next.rows[0].queue, servicePoint: point };
  });
}

async function completeServiceStep(ticketId, point) {
  return inTransaction(async (client) => {
    const step = await client.query(
      `SELECT s.id, t.queue_code AS queue FROM ticket_service_steps s
       JOIN queue_tickets t ON t.id = s.ticket_id
       WHERE s.ticket_id = $1 AND s.service_point = $2 AND s.step_status = 'called'
       ORDER BY s.id DESC LIMIT 1 FOR UPDATE`, [ticketId, point]
    );
    if (!step.rows.length) return { error: 'ไม่พบคิวที่กำลังให้บริการ ณ จุดนี้' };
    if (point === 3) return { error: 'กรุณาเลือกส่งต่อไปจุดบริการ 4 หรือจุดบริการ 7' };
    if (point === 7) return { error: 'กรุณาเลือกส่งต่อไปจุดบริการ 4 จุดบริการ 6 หรือเสร็จสิ้นการรับบริการ' };
    await client.query(`UPDATE ticket_service_steps SET step_status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1`, [step.rows[0].id]);
    let nextPoint = null;
    if (point === 1) nextPoint = 3;
    if (point === 4) nextPoint = 6;
    if (nextPoint) {
      await addStep(client, ticketId, nextPoint);
      await client.query(`UPDATE queue_tickets SET status = 'waiting', counter = NULL, current_service_point = $1 WHERE id = $2`, [nextPoint, ticketId]);
    } else {
      await client.query(`UPDATE queue_tickets SET status = 'done', completed_at = now(), current_service_point = NULL WHERE id = $1`, [ticketId]);
    }
    await addEvent(client, ticketId, 'done', String(point), { servicePoint: point, nextPoint });
    return { ok: true, queue: step.rows[0].queue, servicePoint: point };
  });
}

function getAllowedServiceRoutes(fromPoint) {
  if (fromPoint === 3) return [4, 7];
  if (fromPoint === 7) return [4, 6, 'complete'];
  return [];
}

async function routeServiceStep(ticketId, fromPoint, destination) {
  const allowed = getAllowedServiceRoutes(fromPoint);
  if (!allowed.includes(destination)) throw new Error('เส้นทางส่งต่อไม่ถูกต้อง');
  return inTransaction(async (client) => {
    const step = await client.query(
      `SELECT s.id, t.queue_code AS queue FROM ticket_service_steps s
       JOIN queue_tickets t ON t.id = s.ticket_id
       WHERE s.ticket_id = $1 AND s.service_point = $2 AND s.step_status = 'called'
       ORDER BY s.id DESC LIMIT 1 FOR UPDATE`, [ticketId, fromPoint]
    );
    if (!step.rows.length) return { error: 'ไม่พบคิวที่กำลังให้บริการ ณ จุดนี้' };
    await client.query(`UPDATE ticket_service_steps SET step_status = 'completed', completed_at = now(), updated_at = now() WHERE id = $1`, [step.rows[0].id]);
    if (destination === 'complete') {
      await client.query(`UPDATE queue_tickets SET status = 'done', counter = NULL, completed_at = now(), current_service_point = NULL WHERE id = $1`, [ticketId]);
    } else {
      await addStep(client, ticketId, destination);
      await client.query(`UPDATE queue_tickets SET status = 'waiting', counter = NULL, current_service_point = $1 WHERE id = $2`, [destination, ticketId]);
    }
    await addEvent(client, ticketId, 'routed', String(fromPoint), { fromPoint, destination });
    return { ok: true, queue: step.rows[0].queue, servicePoint: destination === 'complete' ? null : destination };
  });
}

async function skipServiceStep(ticketId, point) {
  return inTransaction(async (client) => {
    const step = await client.query(
      `SELECT s.id, t.queue_code AS queue FROM ticket_service_steps s
       JOIN queue_tickets t ON t.id = s.ticket_id
       WHERE s.ticket_id = $1 AND s.service_point = $2 AND s.step_status = 'called'
       ORDER BY s.id DESC LIMIT 1 FOR UPDATE`, [ticketId, point]
    );
    if (!step.rows.length) return { error: 'ไม่พบคิวที่กำลังให้บริการ ณ จุดนี้' };
    await client.query(`UPDATE ticket_service_steps SET step_status = 'skipped', updated_at = now() WHERE id = $1`, [step.rows[0].id]);
    await client.query(`UPDATE queue_tickets SET status = 'skipped', skipped_at = now(), counter = NULL, current_service_point = $1 WHERE id = $2`, [point, ticketId]);
    await addEvent(client, ticketId, 'skipped', String(point), { servicePoint: point });
    return { ok: true, queue: step.rows[0].queue, servicePoint: point };
  });
}

async function recallServiceStep(ticketId, point) {
  return inTransaction(async (client) => {
    const step = await client.query(
      `SELECT s.id, t.queue_code AS queue FROM ticket_service_steps s
       JOIN queue_tickets t ON t.id = s.ticket_id
       WHERE s.ticket_id = $1 AND s.service_point = $2 AND s.step_status = 'skipped'
       ORDER BY s.id DESC LIMIT 1 FOR UPDATE`, [ticketId, point]
    );
    if (!step.rows.length) return { error: 'ไม่พบคิวที่ข้ามไว้ ณ จุดนี้' };
    const active = await client.query(
      `SELECT 1
       FROM ticket_service_steps active_step
       JOIN queue_tickets active_ticket ON active_ticket.id = active_step.ticket_id
       WHERE active_step.service_point = $1
         AND active_step.step_status = 'called'
         AND active_ticket.queue_date = CURRENT_DATE
         AND active_ticket.status = 'called'
         AND active_ticket.current_service_point = $1
       LIMIT 1
       FOR UPDATE OF active_step, active_ticket`,
      [point]
    );
    if (active.rows.length) return { error: `กรุณาดำเนินการกับคิวปัจจุบันที่จุดบริการ ${point} ให้เสร็จก่อน` };
    await client.query(`UPDATE ticket_service_steps SET step_status = 'called', called_at = now(), updated_at = now() WHERE id = $1`, [step.rows[0].id]);
    await client.query(
      `UPDATE queue_tickets
       SET status = 'called', counter = $1, called_at = now(), skipped_at = NULL,
           current_service_point = $2, call_count = call_count + 1, updated_at = now()
       WHERE id = $3`,
      [String(point), point, ticketId]
    );
    await addEvent(client, ticketId, 'recalled', String(point), { servicePoint: point });
    return { ok: true, queue: step.rows[0].queue, servicePoint: point };
  });
}

async function getServicePoints() {
  const result = await pool.query(`SELECT point_no AS "point", name FROM service_points ORDER BY point_no`);
  return result.rows;
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
    counter: row.counter || null,
    currentPoint: row.currentPoint ? Number(row.currentPoint) : null,
    currentPointName: row.currentPointName || null,
    stepStatus: row.stepStatus || null,
    arrivedAt: row.arrivedAt || row.issuedAt,
    carePlan: row.carePlan || null,
  };
}

async function getQueueData() {
  const result = await pool.query(
    `SELECT t.id, t.queue_code AS "ticketCode", t.category, t.priority,
            t.status, t.sequence_no AS "sequenceNo", t.created_at AS "issuedAt",
            t.called_at AS "calledAt", t.completed_at AS "completedAt",
            t.skipped_at AS "skippedAt", t.phone, t.counter,
            t.current_service_point AS "currentPoint", sp.name AS "currentPointName",
            active_step.step_status AS "stepStatus", active_step.created_at AS "arrivedAt",
            t.care_plan AS "carePlan"
     FROM queue_tickets t
     LEFT JOIN service_points sp ON sp.point_no = t.current_service_point
     LEFT JOIN LATERAL (
       SELECT step_status, created_at FROM ticket_service_steps s
       WHERE s.ticket_id = t.id AND s.step_status IN ('waiting', 'called', 'skipped')
       ORDER BY s.id DESC LIMIT 1
     ) active_step ON true
     WHERE t.queue_date = CURRENT_DATE
     ORDER BY t.created_at ASC, t.id ASC`
  );
  const historyResult = await pool.query(
    `SELECT s.id AS "stepId", t.id AS "ticketId", t.queue_code AS "ticketCode",
            t.category, s.service_point AS "currentPoint", s.completed_at AS "completedAt"
     FROM ticket_service_steps s
     JOIN queue_tickets t ON t.id = s.ticket_id
     WHERE t.queue_date = CURRENT_DATE
       AND s.step_status = 'completed'
       AND s.completed_at IS NOT NULL
       AND (
         (
           s.service_point = 4
           AND EXISTS (
             SELECT 1
             FROM ticket_service_steps next_step
             WHERE next_step.ticket_id = s.ticket_id
               AND next_step.service_point = 6
               AND next_step.id > s.id
           )
         )
         OR
         (
           s.service_point = 7
           AND (
             (
               t.status = 'done'
               AND NOT EXISTS (
                 SELECT 1
                 FROM ticket_service_steps next_step
                 WHERE next_step.ticket_id = s.ticket_id
                   AND next_step.id > s.id
               )
             )
             OR EXISTS (
               SELECT 1
               FROM ticket_service_steps next_step
               WHERE next_step.ticket_id = s.ticket_id
                 AND next_step.service_point = 6
                 AND next_step.id > s.id
             )
           )
         )
       )
     ORDER BY s.completed_at DESC, s.id DESC
     LIMIT 10`
  );
  const tickets = result.rows.map(mapTicketRow);
  const current = tickets.find(ticket => ticket.status === 'called') || null;
  return {
    date: new Date().toISOString().slice(0, 10),
    tickets,
    current,
    waiting: tickets.filter(ticket => ticket.status === 'waiting'),
    skipped: tickets.filter(ticket => ticket.status === 'skipped'),
    history: historyResult.rows.map(row => ({
      id: `history-${row.stepId}`,
      ticketId: String(row.ticketId),
      ticketCode: row.ticketCode,
      category: row.category,
      currentPoint: Number(row.currentPoint),
      completedAt: row.completedAt
    })),
    servicePoints: await getServicePoints()
  };
}

async function resolveReportRange(payload = {}, defaultPeriod = 'month') {
  const allowedPeriods = new Set(['today', 'week', 'month', 'three-months', 'academic-year', 'year', 'custom']);
  const period = allowedPeriods.has(payload.period) ? payload.period : defaultPeriod;
  const customStart = String(payload.start || '');
  const customEnd = String(payload.end || '');
  const requestedYear = Number.parseInt(payload.year, 10);
  const selectedYear = Number.isInteger(requestedYear) && requestedYear >= 2000 && requestedYear <= 2100
    ? requestedYear
    : new Date().getFullYear();

  if (period === 'custom') {
    const validDate = /^\d{4}-\d{2}-\d{2}$/;
    if (!validDate.test(customStart) || !validDate.test(customEnd) || customStart > customEnd) {
      return { error: 'ช่วงวันที่ไม่ถูกต้อง กรุณาตรวจสอบวันเริ่มต้นและวันสิ้นสุด' };
    }
  }

  const boundsResult = await pool.query(
    `SELECT
       CASE $1
         WHEN 'today' THEN CURRENT_DATE
         WHEN 'week' THEN date_trunc('week', CURRENT_DATE)::date
         WHEN 'month' THEN date_trunc('month', CURRENT_DATE)::date
         WHEN 'three-months' THEN (date_trunc('month', CURRENT_DATE) - INTERVAL '2 months')::date
         WHEN 'academic-year' THEN make_date(
           EXTRACT(YEAR FROM CURRENT_DATE)::int - CASE WHEN EXTRACT(MONTH FROM CURRENT_DATE)::int < 6 THEN 1 ELSE 0 END,
           6, 1
         )
         WHEN 'year' THEN make_date($4::int, 1, 1)
         WHEN 'custom' THEN $2::date
       END AS "startDate",
       CASE
         WHEN $1 = 'custom' THEN $3::date
         WHEN $1 = 'year' THEN make_date($4::int, 12, 31)
         ELSE CURRENT_DATE
       END AS "endDate"`,
    [period, period === 'custom' ? customStart : null, period === 'custom' ? customEnd : null, selectedYear]
  );
  const { startDate, endDate } = boundsResult.rows[0];
  return { period, startDate, endDate, selectedYear };
}

async function getDashboard(payload = {}) {
  const range = await resolveReportRange(payload, 'today');
  if (range.error) return range;
  const { period, startDate, endDate, selectedYear } = range;
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
              COALESCE((
                SELECT ROUND(AVG(EXTRACT(EPOCH FROM (step.called_at - step.created_at)) / 60))
                FROM ticket_service_steps step
                JOIN queue_tickets step_ticket ON step_ticket.id = step.ticket_id
                WHERE step_ticket.queue_date BETWEEN $1::date AND $2::date
                  AND step.called_at IS NOT NULL
              ), 0)::int AS "averageWaitMinutes",
              COALESCE((
                SELECT ROUND(AVG(EXTRACT(EPOCH FROM (step.completed_at - step.called_at)) / 60))
                FROM ticket_service_steps step
                JOIN queue_tickets step_ticket ON step_ticket.id = step.ticket_id
                WHERE step_ticket.queue_date BETWEEN $1::date AND $2::date
                  AND step.called_at IS NOT NULL AND step.completed_at IS NOT NULL
              ), 0)::int AS "averageServiceMinutes"
       FROM queue_tickets
       WHERE queue_date BETWEEN $1::date AND $2::date`,
      [startDate, endDate]
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
         ON t.queue_date BETWEEN $1::date AND $2::date
        AND EXTRACT(HOUR FROM t.created_at AT TIME ZONE 'Asia/Bangkok') = hours.hour
       GROUP BY hours.hour
       ORDER BY hours.hour`,
      [startDate, endDate]
    ),
    pool.query(
      `WITH today_steps AS (
         SELECT step.*
         FROM ticket_service_steps step
         JOIN queue_tickets ticket ON ticket.id = step.ticket_id
         WHERE ticket.queue_date BETWEEN $1::date AND $2::date
       )
       SELECT point.point_no::text AS station,
              COUNT(step.id)::int AS served,
              COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (step.called_at - step.created_at)) / 60)
                FILTER (WHERE step.called_at IS NOT NULL)), 0)::int AS "averageWaitMinutes",
              COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (step.completed_at - step.called_at)) / 60)
                FILTER (WHERE step.called_at IS NOT NULL AND step.completed_at IS NOT NULL)), 0)::int AS "averageServiceMinutes"
       FROM service_points point
       LEFT JOIN today_steps step ON step.service_point = point.point_no
       WHERE point.point_no IN (1, 3, 4, 6, 7)
       GROUP BY point.point_no
       ORDER BY point.point_no`,
      [startDate, endDate]
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
    period,
    startDate,
    endDate,
    selectedYear,
    generatedAt: new Date().toISOString()
  };
}

async function getReport(payload = {}) {
  const range = await resolveReportRange(payload);
  if (range.error) return range;
  const { period, startDate, endDate, selectedYear } = range;
  const result = await pool.query(
    `SELECT t.id, t.queue_code AS "ticketCode", t.category, t.priority,
            t.status, t.sequence_no AS "sequenceNo", t.created_at AS "issuedAt",
            t.called_at AS "calledAt", t.completed_at AS "completedAt",
            t.skipped_at AS "skippedAt", t.phone, t.counter,
            t.current_service_point AS "currentPoint", sp.name AS "currentPointName",
            t.care_plan AS "carePlan"
     FROM queue_tickets t
     LEFT JOIN service_points sp ON sp.point_no = t.current_service_point
     WHERE t.queue_date BETWEEN $1::date AND $2::date
     ORDER BY t.queue_date ASC, t.created_at ASC, t.id ASC`,
    [startDate, endDate]
  );
  return {
    period,
    startDate,
    endDate,
    selectedYear,
    tickets: result.rows.map(mapTicketRow)
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
  const counter = cleanCounter(payload.counter || payload.operatorId || '1');
  let result;
  switch (action) {
    case 'getQueue':
      return getQueueData();
    case 'getDashboard':
      return getDashboard(payload);
    case 'getReport':
      return getReport(payload);
    case 'getServicePoints':
      return { servicePoints: await getServicePoints() };
    case 'createTicket': {
      const category = payload.category === 'emergency' ? 'emergency' : 'general';
      const phone = payload.phone ? String(payload.phone).trim().slice(0, 30) : null;
      result = await takeTicket('Q', category, phone);
      break;
    }
    case 'callNext':
      result = await callNext(counter, cleanServicePoint(payload.servicePoint || counter));
      break;
    case 'callTicket':
      result = await callTicketById(cleanTicketId(payload.ticketId), counter);
      break;
    case 'skipTicket':
      result = await skipServiceStep(cleanTicketId(payload.ticketId), cleanServicePoint(payload.servicePoint || counter));
      break;
    case 'recallTicket':
      result = await recallServiceStep(cleanTicketId(payload.ticketId), cleanServicePoint(payload.servicePoint || counter));
      break;
    case 'repeatCall':
      result = await recallCurrent(String(cleanServicePoint(payload.servicePoint || counter)));
      break;
    case 'completeTicket':
      result = await completeServiceStep(cleanTicketId(payload.ticketId), cleanServicePoint(payload.servicePoint || counter));
      break;
    case 'routeServiceTicket': {
      const fromPoint = cleanServicePoint(payload.fromPoint || counter);
      const destination = payload.destination === 'complete'
        ? 'complete'
        : cleanServicePoint(payload.destination);
      result = await routeServiceStep(cleanTicketId(payload.ticketId), fromPoint, destination);
      break;
    }
    case 'cancelTicket':
      result = await cancelTicket(cleanTicketId(payload.ticketId));
      break;
    default:
      throw new Error(`ไม่รู้จักคำสั่ง: ${action}`);
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
      'Allow': 'GET, POST, OPTIONS',
      'Cache-Control': 'no-store'
    });
    return res.end();
  }
  if (req.method !== 'GET') return sendError(res, 405, 'ระบบไม่รองรับวิธีส่งคำขอนี้');

  const action = (url.searchParams.get('action') || 'health').trim();
  const mutatingActions = new Set(['take', 'next', 'recall', 'done', 'skip', 'requeue', 'resetDay']);
  if (mutatingActions.has(action)) {
    return sendError(res, 405, 'คำสั่งเปลี่ยนข้อมูลไม่อนุญาตผ่าน GET กรุณาใช้ POST ที่ผ่านระบบปัจจุบัน');
  }
  try {
    let result;
    switch (action) {
      case 'health':
        result = await getHealth();
        break;
      case 'status':
        result = await getStatus();
        break;
      case 'queueList':
        result = await getQueueList();
        break;
      default:
        return sendError(res, 400, `ไม่รู้จักคำสั่ง: ${action}`);
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
      if (!filePath.startsWith(`${DIST}${path.sep}`)) return sendError(res, 400, 'ที่อยู่ไฟล์ไม่ถูกต้อง');
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

async function shutdown(signal) {
  console.log(`\nReceived ${signal}; shutting down...`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`QueueFlow local server: http://${HOST}:${PORT}`);
    console.log(`Database target: ${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || 5432}/${process.env.PGDATABASE || 'queueflow_dev'}`);
    console.log('Pages: / (home), /#/kiosk, /#/display, /#/login');
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = {
  __pool: pool,
  categoryLabel,
  cleanCounter,
  cleanPrefix,
  cleanQueue,
  cleanServicePoint,
  cleanTicketId,
  getDashboard,
  getAllowedServiceRoutes,
  getHealth,
  getQueueData,
  getQueueList,
  getReport,
  getStatus,
  handleApi,
  handlePostApi,
  mapTicketRow,
  readBody,
  recallServiceStep,
  runReactAction,
  sendError,
  sendJson,
  serveStatic,
};
