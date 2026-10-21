-- QueueFlow local development schema
-- This file is intentionally non-destructive: it only creates missing objects.

DO $$
BEGIN
  CREATE TYPE queue_status AS ENUM ('waiting', 'called', 'done', 'skipped');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE queue_status ADD VALUE IF NOT EXISTS 'cancelled';

CREATE TABLE IF NOT EXISTS queue_sequences (
  queue_date  date        NOT NULL,
  prefix      varchar(10) NOT NULL,
  last_number integer     NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (queue_date, prefix)
);

CREATE TABLE IF NOT EXISTS queue_tickets (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue_date        date        NOT NULL DEFAULT current_date,
  prefix            varchar(10) NOT NULL DEFAULT 'A',
  sequence_no       integer     NOT NULL CHECK (sequence_no > 0),
  -- sequence_no is an internal monotonic number; queue_code is the visible
  -- three-digit ticket number and wraps from 999 back to 001.
  queue_code        text GENERATED ALWAYS AS (prefix || lpad((((sequence_no - 1) % 999) + 1)::text, 3, '0')) STORED,
  category          varchar(20) NOT NULL DEFAULT 'general' CHECK (category IN ('general', 'emergency')),
  phone             varchar(30),
  status            queue_status NOT NULL DEFAULT 'waiting',
  priority          smallint    NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 9),
  counter           varchar(50),
  created_at        timestamptz NOT NULL DEFAULT now(),
  called_at         timestamptz,
  last_recalled_at  timestamptz,
  completed_at      timestamptz,
  skipped_at        timestamptz,
  call_count        integer     NOT NULL DEFAULT 0 CHECK (call_count >= 0),
  requeue_count     integer     NOT NULL DEFAULT 0 CHECK (requeue_count >= 0),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT queue_tickets_sequence_unique UNIQUE (queue_date, prefix, sequence_no)
);

CREATE TABLE IF NOT EXISTS queue_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id   bigint      NOT NULL REFERENCES queue_tickets(id) ON DELETE RESTRICT,
  action      varchar(20) NOT NULL CHECK (action IN ('issued', 'called', 'recalled', 'done', 'skipped', 'requeued', 'cancelled', 'reset')),
  counter     varchar(50),
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE queue_tickets ADD COLUMN IF NOT EXISTS category varchar(20) NOT NULL DEFAULT 'general';
ALTER TABLE queue_tickets ADD COLUMN IF NOT EXISTS phone varchar(30);
-- Rebuild the generated display code so existing databases also get the
-- 001-999 cycle. sequence_no remains unique and keeps increasing internally.
ALTER TABLE queue_tickets DROP COLUMN IF EXISTS queue_code;
ALTER TABLE queue_tickets
  ADD COLUMN queue_code text GENERATED ALWAYS AS
    (prefix || lpad((((sequence_no - 1) % 999) + 1)::text, 3, '0')) STORED;
ALTER TABLE queue_events DROP CONSTRAINT IF EXISTS queue_events_action_check;
ALTER TABLE queue_events ALTER COLUMN action TYPE varchar(40);
ALTER TABLE queue_events ADD CONSTRAINT queue_events_action_check
  CHECK (action IN ('issued', 'called', 'recalled', 'done', 'skipped', 'requeued', 'cancelled', 'reset', 'routed', 'prescription_received', 'medicine_ready'));

-- Service-point workflow. These objects extend the original one-queue model
-- without removing tickets or their event history.
CREATE TABLE IF NOT EXISTS service_points (
  point_no      smallint PRIMARY KEY,
  name          varchar(100) NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (point_no IN (1, 3, 4, 6, 7))
);

INSERT INTO service_points (point_no, name) VALUES
  (1, 'เวชระเบียนและวัดค่าพื้นฐาน'),
  (3, 'คัดกรอง'),
  (4, 'พบแพทย์'),
  (6, 'ส่งใบสั่งยาและรับยา'),
  (7, 'ทำแผล')
ON CONFLICT (point_no) DO NOTHING;

CREATE TABLE IF NOT EXISTS ticket_service_steps (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_id       bigint NOT NULL REFERENCES queue_tickets(id) ON DELETE RESTRICT,
  service_point   smallint NOT NULL REFERENCES service_points(point_no),
  step_status     varchar(24) NOT NULL DEFAULT 'waiting'
                  CHECK (step_status IN ('waiting', 'called', 'preparing', 'ready', 'completed', 'paused', 'skipped')),
  route_order     smallint NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  called_at       timestamptz,
  completed_at    timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE queue_tickets ADD COLUMN IF NOT EXISTS current_service_point smallint;
ALTER TABLE queue_tickets ADD COLUMN IF NOT EXISTS care_plan varchar(20);

-- Existing live tickets continue at point 1 after the migration. Completed
-- and cancelled tickets intentionally do not receive a new active step.
INSERT INTO ticket_service_steps (ticket_id, service_point, step_status, route_order, created_at)
SELECT t.id, 1,
       CASE WHEN t.status = 'called' THEN 'called' ELSE 'waiting' END,
       1, t.created_at
FROM queue_tickets t
WHERE t.status IN ('waiting', 'called', 'skipped')
  AND NOT EXISTS (SELECT 1 FROM ticket_service_steps s WHERE s.ticket_id = t.id);

UPDATE queue_tickets
SET current_service_point = 1
WHERE current_service_point IS NULL
  AND status IN ('waiting', 'called', 'skipped');

CREATE INDEX IF NOT EXISTS ticket_service_steps_queue_idx
  ON ticket_service_steps (service_point, step_status, created_at, id);

CREATE TABLE IF NOT EXISTS app_users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      varchar(100) NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  display_name  varchar(150),
  role          varchar(30)  NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  is_active     boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source        varchar(40) NOT NULL DEFAULT 'google_sheets',
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        varchar(20) NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  rows_read     integer     NOT NULL DEFAULT 0,
  rows_written  integer     NOT NULL DEFAULT 0,
  error_message text
);

CREATE INDEX IF NOT EXISTS queue_tickets_waiting_idx
  ON queue_tickets (queue_date, priority DESC, created_at, id)
  WHERE status = 'waiting';

CREATE INDEX IF NOT EXISTS queue_tickets_called_idx
  ON queue_tickets (queue_date, called_at DESC)
  WHERE status = 'called';

CREATE INDEX IF NOT EXISTS queue_events_ticket_idx
  ON queue_events (ticket_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION touch_queue_ticket_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS queue_tickets_touch_updated_at ON queue_tickets;
CREATE TRIGGER queue_tickets_touch_updated_at
  BEFORE UPDATE ON queue_tickets
  FOR EACH ROW EXECUTE FUNCTION touch_queue_ticket_updated_at();

CREATE OR REPLACE FUNCTION touch_app_user_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_users_touch_updated_at ON app_users;
CREATE TRIGGER app_users_touch_updated_at
  BEFORE UPDATE ON app_users
  FOR EACH ROW EXECUTE FUNCTION touch_app_user_updated_at();
