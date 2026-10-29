# QueueFlow local PostgreSQL setup

This folder contains the non-production schema for the local PostgreSQL instance.
It does not migrate or delete Google Sheets data.

## Create the development database

The easiest option is to run the included setup script. It prompts for the PostgreSQL
password locally, creates `queueflow_dev` only if it is missing, and applies the schema:

```powershell
powershell -ExecutionPolicy Bypass -File .\db\setup-local.ps1
```

The password is held in memory for that process only and is cleared when the script exits.

Run this from PowerShell. PostgreSQL will ask for the `postgres` password interactively;
do not put the password in a command or commit it to the repository.

```powershell
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -h localhost -U postgres -d postgres -c "CREATE DATABASE queueflow_dev;"
```

If the database already exists, PostgreSQL will report that and no data is changed.

## Apply the schema

```powershell
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -h localhost -U postgres -d queueflow_dev -f ".\db\queueflow_schema.sql"
```

The schema is designed for the queue flow currently used by the React UI and local API:

- `queue_tickets` stores issued tickets and their current status.
- `queue_sequences` keeps numbering independent per day and prefix.
- `queue_events` keeps an audit trail for call, recall, done, skip, and requeue actions.
- Visible ticket numbers cycle from `Q001` through `Q999` and then return to `Q001`.
  The database keeps a separate internal sequence number so ticket rows remain unique.
- `app_users` is reserved for the future staff login API; no demo password is inserted.
- `sync_runs` is reserved for the future Google Sheets-to-PostgreSQL nightly sync.

If you already ran setup before restoring the React UI, run `setup-local.ps1` once more.
The schema migration adds ticket category/phone fields and the `cancelled` status without
deleting existing data.

## Start the local API

After the schema is installed, start the local API with a password prompt:

```powershell
powershell -ExecutionPolicy Bypass -File .\server\start-local.ps1
```

Then open:

- `http://127.0.0.1:3000/` — restored UI home selector
- `http://127.0.0.1:3000/#/kiosk` — issue a ticket
- `http://127.0.0.1:3000/#/display` — queue board
- `http://127.0.0.1:3000/#/login` — staff login and admin screens

GET requests are read-only and support `health`, `status`, and `queueList`. Every action that
creates, calls, routes, skips, completes, cancels, or resets queue data must use the current
POST API. Legacy mutating GET actions are rejected with HTTP 405.
